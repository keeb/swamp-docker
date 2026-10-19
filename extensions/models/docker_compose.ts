/**
 * Model `@keeb/docker/compose` — manages Docker Compose service lifecycle
 * (start, stop, update, status, prune) on a remote host over SSH against a
 * compose project directory.
 */
import { z } from "npm:zod@4";
import { assertSshTarget, shellQuote, sshExec, sshExecRaw } from "./lib/ssh.ts";

/** Compose service names: letters, digits, `_`, `.`, `-`. */
const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname or IP address"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')"),
  composePath: z.string().describe(
    "Path to docker-compose directory on remote host",
  ),
  serviceName: z.string().optional().describe(
    "Specific service name (optional, operates on all services if omitted)",
  ),
  pruneOnUpdate: z.boolean().default(false).describe(
    "Run 'docker image prune -f' after a successful update to reclaim disk space",
  ),
  rollbackOnUpdate: z.boolean().default(false).describe(
    "On 'update', capture the running images first and roll back to them if the new deploy fails its health gate",
  ),
  updateHealthTimeout: z.number().default(30).describe(
    "Seconds to wait for services to become running/healthy after 'update' before declaring failure (only used when rollbackOnUpdate is true)",
  ),
});

const ResultSchema = z.object({
  success: z.boolean(),
  output: z.string().optional(),
  timestamp: z.string(),
});

/**
 * Quote a remote directory for `sh`, keeping a leading `~/` unquoted so the
 * remote shell still expands it to the SSH user's home directory.
 */
export function remoteDir(path: string): string {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("composePath is required");
  }
  if (path === "~") return "~";
  if (path.startsWith("~/")) return `~/${shellQuote(path.slice(2))}`;
  return shellQuote(path);
}

/**
 * Render the optional service selector as a leading-space suffix. Accepts one
 * service or several separated by whitespace; each name is validated.
 */
export function serviceSuffix(serviceName: string | undefined): string {
  if (!serviceName || serviceName.trim() === "") return "";
  const names = serviceName.trim().split(/\s+/);
  for (const n of names) {
    if (!SERVICE_NAME_RE.test(n)) {
      throw new Error(`Invalid serviceName '${n}'`);
    }
  }
  return " " + names.join(" ");
}

/** Build `cd <dir> && docker compose <action>[ <services>]`. */
export function composeCmd(
  path: string,
  serviceName: string | undefined,
  action: string,
): string {
  return `cd ${remoteDir(path)} && docker compose ${action}${
    serviceSuffix(serviceName)
  }`;
}

/** Image a service was running before an update. */
export interface CapturedImage {
  ref: string;
  sha: string;
}

/** Parse `docker inspect --format '{{.Config.Image}}|{{.Image}}'` lines. */
export function parseCaptured(stdout: string): CapturedImage[] {
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [ref = "", sha = ""] = line.trim().split("|");
    return { ref, sha };
  });
}

/**
 * Capture the currently-running image of each targeted service as `{ref, sha}`,
 * where `ref` is the image as written in the compose file (e.g. `repo:tag`) and
 * `sha` is the resolved image ID. The old image survives as an untagged sha256
 * after a `pull` (as long as it isn't pruned), which is what makes rollback
 * possible.
 */
async function captureImages(
  sshHost: string,
  sshUser: string,
  composePath: string,
  serviceName: string | undefined,
): Promise<CapturedImage[]> {
  const idsRes = await sshExecRaw(
    sshHost,
    sshUser,
    composeCmd(composePath, serviceName, "ps -q"),
  );
  if (idsRes.code !== 0) {
    throw new Error(
      `Could not list running containers for rollback (exit ${idsRes.code}): ${
        idsRes.stderr.slice(-500)
      }`,
    );
  }
  const ids = idsRes.stdout.trim().split("\n").map((s) => s.trim()).filter(
    Boolean,
  );
  if (ids.length === 0) return [];
  const insRes = await sshExecRaw(
    sshHost,
    sshUser,
    `docker inspect --format '{{.Config.Image}}|{{.Image}}' ${
      ids.map(shellQuote).join(" ")
    }`,
  );
  if (insRes.code !== 0) {
    throw new Error(
      `Could not inspect running containers for rollback (exit ${insRes.code}): ${
        insRes.stderr.slice(-500)
      }`,
    );
  }
  return parseCaptured(insRes.stdout);
}

/** Parse `docker compose ps --format json`, tolerating both JSON-array and
 * JSON-lines (one object per line) output across compose versions. */
export function parsePs(stdout: string): Record<string, unknown>[] {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const text = stdout.trim();
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return (Array.isArray(v) ? v : [v]).filter(isObj);
  } catch (_) {
    return text.split("\n").filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch (_e) {
        return null;
      }
    }).filter(isObj);
  }
}

/**
 * Classify one `docker compose ps` snapshot: `ready` when every service is
 * running (and healthy if it has a healthcheck), `terminal` when one exited,
 * died or is unhealthy, otherwise `waiting`.
 */
export function evaluateHealth(
  services: Record<string, unknown>[],
): { status: "ready" | "terminal" | "waiting"; reason: string } {
  if (services.length === 0) {
    return { status: "waiting", reason: "no services reported" };
  }
  let waitingReason = "";
  for (const s of services) {
    const name = String(s.Service || s.Name || "?");
    const state = String(s.State || "").toLowerCase();
    const health = String(s.Health || "").toLowerCase();
    if (state !== "running") {
      const reason = `${name} state=${state || "unknown"}`;
      if (state === "exited" || state === "dead") {
        return { status: "terminal", reason };
      }
      waitingReason ||= reason;
      continue;
    }
    if (health === "unhealthy") {
      return { status: "terminal", reason: `${name} health=unhealthy` };
    }
    if (health === "starting") {
      waitingReason ||= `${name} health=starting`;
    }
  }
  return waitingReason
    ? { status: "waiting", reason: waitingReason }
    : { status: "ready", reason: "" };
}

/**
 * Poll `docker compose ps` until every targeted service is `running` (and
 * `healthy`, if it defines a healthcheck) or the timeout elapses. Returns
 * `{ ok }` on success; on failure `{ ok: false, reason }`. A terminal failure
 * (a service `exited` or `unhealthy`) returns early rather than waiting out the
 * full timeout.
 */
export async function waitHealthy(
  sshHost: string,
  sshUser: string,
  composePath: string,
  serviceName: string | undefined,
  timeoutSec: number,
  pollMs = 3000,
): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + timeoutSec * 1000;
  let reason = "no services reported";
  while (Date.now() < deadline) {
    const res = await sshExecRaw(
      sshHost,
      sshUser,
      composeCmd(composePath, serviceName, "ps --format json"),
    );
    if (res.code !== 0) {
      reason = `docker compose ps failed (exit ${res.code})`;
    } else {
      const verdict = evaluateHealth(parsePs(res.stdout));
      if (verdict.status === "ready") return { ok: true };
      reason = verdict.reason;
      if (verdict.status === "terminal") return { ok: false, reason };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, reason: `timed out after ${timeoutSec}s (${reason})` };
}

/** Re-point each captured service's tag back to its old image ID and recreate
 * the containers on it. Tag restore uses sshExecRaw so a single failure (e.g. a
 * digest-pinned ref that can't be re-tagged) doesn't abort the whole rollback. */
async function rollback(
  sshHost: string,
  sshUser: string,
  composePath: string,
  serviceName: string | undefined,
  captured: CapturedImage[],
  log: (msg: string) => void,
): Promise<void> {
  for (const { ref, sha } of captured) {
    if (!ref || !sha || ref.includes("@")) {
      log(`Skipping retag for '${ref}' (no mutable tag to restore)`);
      continue;
    }
    log(`Restoring '${ref}' -> ${sha.slice(0, 19)}`);
    const tag = await sshExecRaw(
      sshHost,
      sshUser,
      `docker tag ${shellQuote(sha)} ${shellQuote(ref)}`,
    );
    if (tag.code !== 0) {
      log(`Retag of '${ref}' failed (exit ${tag.code}): ${tag.stderr.trim()}`);
    }
  }
  await sshExec(
    sshHost,
    sshUser,
    composeCmd(composePath, serviceName, "up -d"),
  );
}

/** Roll back, folding a rollback failure into the error that is thrown. */
async function rollbackAndThrow(
  sshHost: string,
  sshUser: string,
  composePath: string,
  serviceName: string | undefined,
  captured: CapturedImage[],
  log: (msg: string) => void,
  failure: string,
): Promise<never> {
  if (captured.length === 0) {
    log(`No previously running images were captured; nothing to roll back to`);
    throw new Error(
      `${failure}; no previously running images were captured, so nothing was rolled back`,
    );
  }
  try {
    await rollback(sshHost, sshUser, composePath, serviceName, captured, log);
  } catch (err) {
    throw new Error(
      `${failure}; rollback ALSO failed: ${(err as Error).message}`,
    );
  }
  throw new Error(`${failure}; rolled back to the previous images`);
}

// deno-lint-ignore no-explicit-any
type Ctx = any;

interface ComposeArgs {
  sshHost: string;
  sshUser: string;
  composePath: string;
  serviceName?: string;
  pruneOnUpdate: boolean;
  rollbackOnUpdate: boolean;
  updateHealthTimeout: number;
}

/** Validate global arguments before any remote command runs. */
function preflight(context: Ctx): ComposeArgs {
  const g = context.globalArgs;
  const sshUser = g.sshUser ?? "root";
  assertSshTarget(g.sshHost, sshUser);
  // Throws on an empty path or an invalid service name.
  composeCmd(g.composePath, g.serviceName, "ps");
  const updateHealthTimeout = g.updateHealthTimeout ?? 30;
  if (!Number.isFinite(updateHealthTimeout) || updateHealthTimeout <= 0) {
    throw new Error(
      `updateHealthTimeout must be a positive number of seconds, got ${updateHealthTimeout}`,
    );
  }
  return {
    sshHost: g.sshHost,
    sshUser,
    composePath: g.composePath,
    serviceName: g.serviceName,
    pruneOnUpdate: g.pruneOnUpdate ?? false,
    rollbackOnUpdate: g.rollbackOnUpdate ?? false,
    updateHealthTimeout,
  };
}

/** Docker Compose lifecycle model definition. */
export const model = {
  type: "@keeb/docker/compose",
  version: "2026.05.31.2",
  upgrades: [
    {
      toVersion: "2026.05.31.2",
      description:
        "No-op: pruneOnUpdate, rollbackOnUpdate and updateHealthTimeout have schema defaults, so existing arguments carry over unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "result": {
      description: "Docker compose operation result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  checks: {
    "valid-compose-target": {
      description:
        "sshHost/sshUser are safe ssh values, composePath is set, serviceName and updateHealthTimeout are valid",
      labels: ["policy"],
      execute: (context: Ctx) => {
        try {
          preflight(context);
          return Promise.resolve({ pass: true });
        } catch (err) {
          return Promise.resolve({
            pass: false,
            errors: [(err as Error).message],
          });
        }
      },
    },
  },
  methods: {
    start: {
      description: "Start Docker Compose services",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const { sshHost, sshUser, composePath, serviceName } = preflight(
          context,
        );
        const cmd = composeCmd(composePath, serviceName, "up -d");

        context.logger.info("Starting services at {host}:{path}", {
          host: sshHost,
          path: composePath,
        });
        const result = await sshExec(sshHost, sshUser, cmd);

        context.logger.info("Services started at {host}:{path}", {
          host: sshHost,
          path: composePath,
        });
        const handle = await context.writeResource("result", "result", {
          success: true,
          output: result.stdout || result.stderr,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Stop Docker Compose services",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const { sshHost, sshUser, composePath, serviceName } = preflight(
          context,
        );
        const cmd = composeCmd(composePath, serviceName, "down") +
          " && sleep 3";

        context.logger.info("Stopping services at {host}:{path}", {
          host: sshHost,
          path: composePath,
        });
        const result = await sshExec(sshHost, sshUser, cmd);

        context.logger.info("Services stopped at {host}:{path}", {
          host: sshHost,
          path: composePath,
        });
        const handle = await context.writeResource("result", "result", {
          success: true,
          output: result.stdout || result.stderr,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    update: {
      description:
        "Pull latest images and restart Docker Compose services; optionally health-gate the new deploy and roll back to the previous images on failure",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const {
          sshHost,
          sshUser,
          composePath,
          serviceName,
          pruneOnUpdate,
          rollbackOnUpdate,
          updateHealthTimeout,
        } = preflight(context);
        const logs: string[] = [];
        const log = (msg: string) => {
          logs.push(msg);
          context.logger.info("[update] {msg}", { msg });
        };

        log(`Updating services at ${sshHost}:${composePath}`);

        // Capture the running images BEFORE pulling, so we can roll back to
        // them. Must happen before `pull` overwrites the mutable tags.
        let captured: CapturedImage[] = [];
        if (rollbackOnUpdate) {
          captured = await captureImages(
            sshHost,
            sshUser,
            composePath,
            serviceName,
          );
          log(`Captured ${captured.length} image(s) for rollback`);
        }

        // Pull first. If this fails nothing has changed yet, so just surface
        // the error — there is nothing to roll back to.
        const pull = await sshExec(
          sshHost,
          sshUser,
          composeCmd(composePath, serviceName, "pull"),
        );
        log((pull.stdout || pull.stderr).trim());

        if (!rollbackOnUpdate) {
          // Legacy behaviour: bring services up, optionally prune, done.
          const up = await sshExec(
            sshHost,
            sshUser,
            composeCmd(composePath, serviceName, "up -d"),
          );
          log((up.stdout || up.stderr).trim());
          if (pruneOnUpdate) {
            log(`Pruning dangling images`);
            await sshExec(sshHost, sshUser, `docker image prune -f`);
          }
          log(`Services updated successfully`);
          const handle = await context.writeResource("result", "result", {
            success: true,
            output: logs.join("\n"),
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        // Rollback-protected path: bring services up, then health-gate them.
        try {
          const up = await sshExec(
            sshHost,
            sshUser,
            composeCmd(composePath, serviceName, "up -d"),
          );
          log((up.stdout || up.stderr).trim());
        } catch (err) {
          const message = (err as Error).message;
          log(`'up -d' failed (${message}) — rolling back`);
          await rollbackAndThrow(
            sshHost,
            sshUser,
            composePath,
            serviceName,
            captured,
            log,
            `Update failed during 'up -d': ${message}`,
          );
        }

        log(`Health gate: waiting up to ${updateHealthTimeout}s for services`);
        const health = await waitHealthy(
          sshHost,
          sshUser,
          composePath,
          serviceName,
          updateHealthTimeout,
        );
        if (!health.ok) {
          log(`Health gate failed (${health.reason}) — rolling back`);
          await rollbackAndThrow(
            sshHost,
            sshUser,
            composePath,
            serviceName,
            captured,
            log,
            `Update health gate failed (${health.reason})\n${logs.join("\n")}`,
          );
        }
        log(`Health gate passed`);

        // Prune only after a healthy deploy — pruning earlier would delete the
        // old images we'd need for rollback.
        if (pruneOnUpdate) {
          log(`Pruning dangling images`);
          await sshExec(sshHost, sshUser, `docker image prune -f`);
        }

        log(`Services updated successfully`);
        const handle = await context.writeResource("result", "result", {
          success: true,
          output: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description: "Show Docker Compose service status",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const { sshHost, sshUser, composePath, serviceName } = preflight(
          context,
        );
        const cmd = composeCmd(composePath, serviceName, "ps");

        context.logger.info("Checking services at {host}:{path}", {
          host: sshHost,
          path: composePath,
        });
        const result = await sshExec(sshHost, sshUser, cmd);

        context.logger.info("Service status:\n{status}", {
          status: result.stdout,
        });
        const handle = await context.writeResource("result", "result", {
          success: true,
          output: result.stdout,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    prune: {
      description:
        "Remove dangling Docker images on the remote host to reclaim disk space",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const g = context.globalArgs;
        const sshUser = g.sshUser ?? "root";
        assertSshTarget(g.sshHost, sshUser);
        // Dangling-only (no -a): safe, never removes tagged images or running
        // containers' images.
        const cmd = "docker image prune -f";

        context.logger.info("Pruning dangling images at {host}", {
          host: g.sshHost,
        });
        const result = await sshExec(g.sshHost, sshUser, cmd);

        context.logger.info("Prune complete at {host}", { host: g.sshHost });
        const handle = await context.writeResource("result", "result", {
          success: true,
          output: result.stdout || result.stderr,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
