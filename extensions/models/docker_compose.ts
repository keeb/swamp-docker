/**
 * Model `@keeb/docker/compose` — manages Docker Compose service lifecycle
 * (start, stop, update, status) on a remote host over SSH against a compose
 * project directory.
 */
import { z } from "npm:zod@4";
import { sshExec, sshExecRaw } from "./lib/ssh.ts";

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

function composeCmd(path, serviceName, action) {
  const svc = serviceName ? ` ${serviceName}` : "";
  return `cd ${path} && docker compose ${action}${svc}`;
}

/**
 * Capture the currently-running image of each targeted service as `{ref, sha}`,
 * where `ref` is the image as written in the compose file (e.g. `repo:tag`) and
 * `sha` is the resolved image ID. The old image survives as an untagged sha256
 * after a `pull` (as long as it isn't pruned), which is what makes rollback
 * possible.
 */
async function captureImages(sshHost, sshUser, composePath, serviceName) {
  const svc = serviceName ? ` ${serviceName}` : "";
  const idsRes = await sshExecRaw(
    sshHost,
    sshUser,
    `cd ${composePath} && docker compose ps -q${svc}`,
  );
  const ids = idsRes.stdout.trim().split("\n").filter(Boolean);
  if (ids.length === 0) return [];
  const insRes = await sshExecRaw(
    sshHost,
    sshUser,
    `docker inspect --format '{{.Config.Image}}|{{.Image}}' ${ids.join(" ")}`,
  );
  return insRes.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [ref, sha] = line.split("|");
    return { ref, sha };
  });
}

/** Parse `docker compose ps --format json`, tolerating both JSON-array and
 * JSON-lines (one object per line) output across compose versions. */
function parsePs(stdout) {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  } catch (_) {
    return text.split("\n").filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch (_e) {
        return null;
      }
    }).filter(Boolean);
  }
}

/**
 * Poll `docker compose ps` until every targeted service is `running` (and
 * `healthy`, if it defines a healthcheck) or the timeout elapses. Returns
 * `{ ok }` on success; on failure `{ ok: false, reason }`. A terminal failure
 * (a service `exited` or `unhealthy`) returns early rather than waiting out the
 * full timeout.
 */
async function waitHealthy(
  sshHost,
  sshUser,
  composePath,
  serviceName,
  timeoutSec,
) {
  const svc = serviceName ? ` ${serviceName}` : "";
  const deadline = Date.now() + timeoutSec * 1000;
  let reason = "no services reported";
  while (Date.now() < deadline) {
    const res = await sshExecRaw(
      sshHost,
      sshUser,
      `cd ${composePath} && docker compose ps --format json${svc}`,
    );
    const services = parsePs(res.stdout);
    if (services.length > 0) {
      let allReady = true;
      let terminal = false;
      for (const s of services) {
        const name = s.Service || s.Name || "?";
        const state = String(s.State || "").toLowerCase();
        const health = String(s.Health || "").toLowerCase();
        if (state !== "running") {
          allReady = false;
          reason = `${name} state=${state || "unknown"}`;
          if (state === "exited" || state === "dead") terminal = true;
          break;
        }
        if (health === "unhealthy") {
          allReady = false;
          reason = `${name} health=unhealthy`;
          terminal = true;
          break;
        }
        if (health === "starting") {
          allReady = false;
          reason = `${name} health=starting`;
        }
      }
      if (allReady) return { ok: true };
      if (terminal) return { ok: false, reason };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, reason: `timed out after ${timeoutSec}s (${reason})` };
}

/** Re-point each captured service's tag back to its old image ID and recreate
 * the containers on it. Tag restore uses sshExecRaw so a single failure (e.g. a
 * digest-pinned ref that can't be re-tagged) doesn't abort the whole rollback. */
async function rollback(
  sshHost,
  sshUser,
  composePath,
  serviceName,
  captured,
  log,
) {
  for (const { ref, sha } of captured) {
    if (!ref || !sha || ref.includes("@")) {
      log(`Skipping retag for '${ref}' (no mutable tag to restore)`);
      continue;
    }
    log(`Restoring '${ref}' -> ${sha.slice(0, 19)}`);
    await sshExecRaw(sshHost, sshUser, `docker tag ${sha} ${ref}`);
  }
  const svc = serviceName ? ` ${serviceName}` : "";
  await sshExec(
    sshHost,
    sshUser,
    `cd ${composePath} && docker compose up -d${svc}`,
  );
}

/** Docker Compose lifecycle model definition. */
export const model = {
  type: "@keeb/docker/compose",
  version: "2026.05.31.2",
  resources: {
    "result": {
      description: "Docker compose operation result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  methods: {
    start: {
      description: "Start Docker Compose services",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root", composePath, serviceName } =
          context.globalArgs;
        const cmd = composeCmd(composePath, serviceName, "up -d");

        console.log(`[start] Starting services at ${sshHost}:${composePath}`);
        const result = await sshExec(sshHost, sshUser, cmd);

        console.log(`[start] Services started successfully`);
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
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root", composePath, serviceName } =
          context.globalArgs;
        const cmd = composeCmd(composePath, serviceName, "down") +
          " && sleep 3";

        console.log(`[stop] Stopping services at ${sshHost}:${composePath}`);
        const result = await sshExec(sshHost, sshUser, cmd);

        console.log(`[stop] Services stopped successfully`);
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
      execute: async (_args, context) => {
        const {
          sshHost,
          sshUser = "root",
          composePath,
          serviceName,
          pruneOnUpdate,
          rollbackOnUpdate,
          updateHealthTimeout,
        } = context.globalArgs;
        const svc = serviceName ? ` ${serviceName}` : "";
        const logs = [];
        const log = (msg) => {
          logs.push(msg);
          console.log(`[update] ${msg}`);
        };

        log(`Updating services at ${sshHost}:${composePath}`);

        // Capture the running images BEFORE pulling, so we can roll back to
        // them. Must happen before `pull` overwrites the mutable tags.
        let captured = [];
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
          `cd ${composePath} && docker compose pull${svc}`,
        );
        log((pull.stdout || pull.stderr).trim());

        if (!rollbackOnUpdate) {
          // Legacy behaviour: bring services up, optionally prune, done.
          const up = await sshExec(
            sshHost,
            sshUser,
            `cd ${composePath} && docker compose up -d${svc}`,
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
            `cd ${composePath} && docker compose up -d${svc}`,
          );
          log((up.stdout || up.stderr).trim());
        } catch (err) {
          log(`'up -d' failed (${err.message}) — rolling back`);
          await rollback(
            sshHost,
            sshUser,
            composePath,
            serviceName,
            captured,
            log,
          );
          throw new Error(
            `Update failed during 'up -d' and was rolled back to the previous images: ${err.message}`,
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
          await rollback(
            sshHost,
            sshUser,
            composePath,
            serviceName,
            captured,
            log,
          );
          throw new Error(
            `Update health gate failed (${health.reason}); rolled back to the previous images.\n${
              logs.join("\n")
            }`,
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
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root", composePath, serviceName } =
          context.globalArgs;
        const cmd = composeCmd(composePath, serviceName, "ps");

        console.log(`[status] Checking services at ${sshHost}:${composePath}`);
        const result = await sshExec(sshHost, sshUser, cmd);

        console.log(`[status] Service status:\n${result.stdout}`);
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
      execute: async (_args, context) => {
        const { sshHost, sshUser = "root" } = context.globalArgs;
        // Dangling-only (no -a): safe, never removes tagged images or running
        // containers' images.
        const cmd = "docker image prune -f";

        console.log(`[prune] Pruning dangling images at ${sshHost}`);
        const result = await sshExec(sshHost, sshUser, cmd);

        console.log(`[prune] Prune complete`);
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
