/**
 * Model `@keeb/docker/compose` — manages Docker Compose service lifecycle
 * (start, stop, update, status) on a remote host over SSH against a compose
 * project directory.
 */
import { z } from "npm:zod@4";
import { sshExec } from "./lib/ssh.ts";

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

/** Docker Compose lifecycle model definition. */
export const model = {
  type: "@keeb/docker/compose",
  version: "2026.05.31.1",
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
      description: "Pull latest images and restart Docker Compose services",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const {
          sshHost,
          sshUser = "root",
          composePath,
          serviceName,
          pruneOnUpdate,
        } = context.globalArgs;
        const svc = serviceName ? ` ${serviceName}` : "";
        // Chaining prune with && ensures it only runs on a successful update.
        const prune = pruneOnUpdate ? ` && docker image prune -f` : "";
        const cmd =
          `cd ${composePath} && docker compose pull${svc} && docker compose up -d${svc}${prune}`;

        console.log(`[update] Updating services at ${sshHost}:${composePath}`);
        if (pruneOnUpdate) {
          console.log(
            `[update] pruneOnUpdate enabled — will prune dangling images after update`,
          );
        }
        const result = await sshExec(sshHost, sshUser, cmd);

        console.log(`[update] Services updated successfully`);
        const handle = await context.writeResource("result", "result", {
          success: true,
          output: result.stdout || result.stderr,
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
