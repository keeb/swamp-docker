/**
 * Model `@keeb/docker/engine` — installs Docker Engine on a remote Alpine host
 * and manages image and container lifecycle over SSH. Provides `install`,
 * `build`, `run`, `stop`, `inspect`, and `exec` methods.
 */
import { z } from "npm:zod@4";
import { assertSshTarget, shellQuote, sshExec, sshExecRaw } from "./lib/ssh.ts";

/** Docker's own container-name rule. */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
/** Environment variable names accepted for the generated env file. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const GlobalArgs = z.object({
  sshHost: z.string().describe("SSH hostname/IP of the target VM"),
  sshUser: z.string().default("root").describe("SSH user (default 'root')"),
});

const ResultSchema = z.object({
  success: z.boolean(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const ImageSchema = z.object({
  imageTag: z.string(),
  context: z.string(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const ContainerSchema = z.object({
  containerName: z.string(),
  imageTag: z.string(),
  running: z.boolean(),
  containerId: z.string().optional(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const ContainerName = z.string().regex(CONTAINER_NAME_RE).describe(
  "Container name ([a-zA-Z0-9][a-zA-Z0-9_.-]+)",
);

/**
 * Quote a remote path for `sh`, keeping a leading `~/` unquoted so the remote
 * shell still expands it to the SSH user's home directory.
 */
export function remotePath(path: string): string {
  if (path === "~") return "~";
  if (path.startsWith("~/")) return `~/${shellQuote(path.slice(2))}`;
  return shellQuote(path);
}

/**
 * Normalise a `ports`/`volumes` argument: an array of strings, a JSON array
 * string, or a single plain value. Throws a descriptive error otherwise.
 */
export function parseStringList(
  value: string | string[] | undefined,
  field: string,
): string[] {
  if (value === undefined || value === "") return [];
  let list: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        list = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(
          `Invalid ${field}: not a valid JSON array (${
            (err as Error).message
          })`,
        );
      }
    } else {
      list = [trimmed];
    }
  }
  if (!Array.isArray(list) || !list.every((v) => typeof v === "string")) {
    throw new Error(`Invalid ${field}: expected an array of strings`);
  }
  return list as string[];
}

/** Parse the `env` argument (a JSON object string) into validated entries. */
export function parseEnv(value: string | undefined): [string, string][] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new Error(
      `Invalid env: not valid JSON (${(err as Error).message})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid env: expected a JSON object of NAME: value");
  }
  return Object.entries(parsed).map(([k, v]) => {
    if (!ENV_KEY_RE.test(k)) {
      throw new Error(`Invalid env: variable name '${k}' is not allowed`);
    }
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (/[\r\n]/.test(s)) {
      throw new Error(
        `Invalid env: value for '${k}' contains a newline, which env files cannot hold`,
      );
    }
    return [k, s];
  });
}

/** Build the remote `docker run` command line; every value is shell-quoted. */
export function buildRunCommand(opts: {
  containerName: string;
  imageTag: string;
  restart?: string;
  ports: string[];
  volumes: string[];
  envFilePath?: string;
  command?: string;
}): string {
  const parts = [
    "docker",
    "run",
    "-d",
    "--name",
    shellQuote(opts.containerName),
  ];
  if (opts.restart) parts.push("--restart", shellQuote(opts.restart));
  for (const p of opts.ports) parts.push("-p", shellQuote(p));
  for (const v of opts.volumes) parts.push("-v", shellQuote(v));
  if (opts.envFilePath) parts.push("--env-file", remotePath(opts.envFilePath));
  parts.push(shellQuote(opts.imageTag));
  // `command` is intentionally passed through unquoted: it is a shell command
  // line for the container (e.g. "sh -c 'echo hi'"), split by the remote shell.
  if (opts.command) parts.push(opts.command);
  return parts.join(" ");
}

/** Parse `docker inspect --format '{{.State.Running}} {{.Id}} {{.Config.Image}}'`. */
export function parseInspectOutput(stdout: string): {
  running: boolean;
  containerId: string;
  imageTag: string;
} {
  const parts = stdout.trim().split(/\s+/);
  return {
    running: parts[0] === "true",
    containerId: parts[1] || "",
    imageTag: parts[2] || "",
  };
}

// deno-lint-ignore no-explicit-any
type Ctx = any;

function target(context: Ctx): { sshHost: string; sshUser: string } {
  const { sshHost, sshUser = "root" } = context.globalArgs;
  assertSshTarget(sshHost, sshUser);
  return { sshHost, sshUser };
}

/** Docker Engine lifecycle model definition. */
export const model = {
  type: "@keeb/docker/engine",
  version: "2026.02.11.2",
  upgrades: [
    {
      toVersion: "2026.02.11.2",
      description: "Version bump, no globalArguments schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "result": {
      description: "Docker engine operation result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "image": {
      description: "Docker image build result",
      schema: ImageSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    "container": {
      description: "Docker container state",
      schema: ContainerSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  checks: {
    "valid-ssh-target": {
      description:
        "sshHost is a hostname or IP and sshUser a login name (neither can be read as an ssh option)",
      labels: ["policy"],
      execute: (context: Ctx) => {
        try {
          const { sshHost, sshUser = "root" } = context.globalArgs;
          assertSshTarget(sshHost, sshUser);
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
    install: {
      description: "Install Docker Engine on an Alpine VM via SSH",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const { sshHost, sshUser } = target(context);
        const logs: string[] = [];
        const log = (msg: string) => logs.push(msg);

        context.logger.info("Installing Docker on {host}", { host: sshHost });
        log(`Installing Docker on ${sshHost}`);
        const result = await sshExec(
          sshHost,
          sshUser,
          `apk add docker && rc-update add docker default && service docker start`,
        );
        log(`Docker installed and started`);
        log(result.stdout || result.stderr);
        context.logger.info("Docker installed and started on {host}", {
          host: sshHost,
        });

        const handle = await context.writeResource("result", "result", {
          success: true,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    build: {
      description: "Build a Docker image on the remote host",
      arguments: z.object({
        imageTag: z.string().min(1).describe("Tag for the built image"),
        contextPath: z.string().min(1).describe(
          "Build context path on remote host",
        ),
        dockerfilePath: z.string().optional().describe(
          "Path to Dockerfile (relative to context)",
        ),
      }),
      execute: async (
        args: {
          imageTag: string;
          contextPath: string;
          dockerfilePath?: string;
        },
        context: Ctx,
      ) => {
        const { sshHost, sshUser } = target(context);
        const { imageTag, contextPath } = args;
        const dfFlag = args.dockerfilePath
          ? ` -f ${remotePath(args.dockerfilePath)}`
          : "";
        const logs: string[] = [];
        const log = (msg: string) => logs.push(msg);

        context.logger.info("Building image {tag} on {host}", {
          tag: imageTag,
          host: sshHost,
        });
        log(
          `Building image '${imageTag}' on ${sshHost} (context: ${contextPath})`,
        );
        const result = await sshExec(
          sshHost,
          sshUser,
          `docker build -t ${shellQuote(imageTag)}${dfFlag} ${
            remotePath(contextPath)
          }`,
        );
        log(`Image '${imageTag}' built`);
        log((result.stdout || result.stderr).trim());
        context.logger.info("Image {tag} built", { tag: imageTag });

        const handle = await context.writeResource("image", imageTag, {
          imageTag,
          context: contextPath,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    run: {
      description:
        "Run a Docker container (stops existing container with same name first)",
      arguments: z.object({
        containerName: ContainerName,
        imageTag: z.string().min(1).describe("Image to run"),
        ports: z.union([z.array(z.string()), z.string()]).optional().describe(
          "Port mappings (e.g. ['8080:8080'])",
        ),
        volumes: z.union([z.array(z.string()), z.string()]).optional().describe(
          "Volume mounts",
        ),
        env: z.string().optional().describe(
          "Environment variables as JSON object string",
        ),
        envFile: z.string().optional().describe(
          "Path to env file on remote host",
        ),
        restart: z.string().optional().describe(
          "Restart policy (e.g. 'unless-stopped')",
        ),
        command: z.string().optional().describe(
          "Command to run in the container (passed to the remote shell as-is)",
        ),
      }),
      execute: async (
        args: {
          containerName: string;
          imageTag: string;
          ports?: string | string[];
          volumes?: string | string[];
          env?: string;
          envFile?: string;
          restart?: string;
          command?: string;
        },
        context: Ctx,
      ) => {
        const { sshHost, sshUser } = target(context);
        const { containerName, imageTag } = args;
        if (!CONTAINER_NAME_RE.test(containerName)) {
          throw new Error(`Invalid containerName '${containerName}'`);
        }
        // Validate every input before touching the remote host.
        const ports = parseStringList(args.ports, "ports");
        const volumes = parseStringList(args.volumes, "volumes");
        const env = parseEnv(args.env);
        const logs: string[] = [];
        const log = (msg: string) => logs.push(msg);

        context.logger.info("Running container {name} from {image} on {host}", {
          name: containerName,
          image: imageTag,
          host: sshHost,
        });

        // Stop and remove existing container (idempotent)
        log(`Stopping old container '${containerName}' if it exists`);
        const q = shellQuote(containerName);
        await sshExecRaw(
          sshHost,
          sshUser,
          `docker stop ${q} 2>/dev/null; docker rm ${q} 2>/dev/null; true`,
        );

        // Write a private, temporary env file when an env record is provided.
        let envFilePath = args.envFile;
        let tempEnvFile: string | undefined;
        if (env.length > 0 && envFilePath) {
          log(`Both env and envFile given; using envFile ${envFilePath}`);
        } else if (env.length > 0) {
          tempEnvFile = `/tmp/${containerName}.env`;
          envFilePath = tempEnvFile;
        }

        const runCmd = buildRunCommand({
          containerName,
          imageTag,
          restart: args.restart,
          ports,
          volumes,
          envFilePath,
          command: args.command,
        });

        let result;
        try {
          if (tempEnvFile) {
            log(`Writing env file to ${tempEnvFile}`);
            // Values travel on stdin, never in an argument list.
            const f = shellQuote(tempEnvFile);
            await sshExec(
              sshHost,
              sshUser,
              `(umask 077 && rm -f ${f} && cat > ${f})`,
              { stdin: env.map(([k, v]) => `${k}=${v}\n`).join("") },
            );
          }
          log(`Starting container '${containerName}' with image '${imageTag}'`);
          log(`Command: ${runCmd}`);
          result = await sshExec(sshHost, sshUser, runCmd);
        } finally {
          // docker copies the env into the container config at create time,
          // so the temporary file (which may hold secrets) is not needed.
          if (tempEnvFile) {
            await sshExecRaw(
              sshHost,
              sshUser,
              `rm -f ${shellQuote(tempEnvFile)}`,
            );
          }
        }
        const containerId = result.stdout.trim();
        log(
          `Container '${containerName}' running (${containerId.slice(0, 12)})`,
        );
        context.logger.info("Container {name} running ({id})", {
          name: containerName,
          id: containerId.slice(0, 12),
        });

        const handle = await context.writeResource("container", containerName, {
          containerName,
          imageTag,
          running: true,
          containerId,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Stop and remove a Docker container (idempotent)",
      arguments: z.object({
        containerName: ContainerName,
      }),
      execute: async (args: { containerName: string }, context: Ctx) => {
        const { sshHost, sshUser } = target(context);
        const { containerName } = args;
        if (!CONTAINER_NAME_RE.test(containerName)) {
          throw new Error(`Invalid containerName '${containerName}'`);
        }
        const logs: string[] = [];
        const log = (msg: string) => logs.push(msg);
        const q = shellQuote(containerName);

        context.logger.info("Stopping container {name} on {host}", {
          name: containerName,
          host: sshHost,
        });
        log(`Stopping container '${containerName}' on ${sshHost}`);
        // Record the image before removal so the stored state stays truthful.
        const before = await sshExecRaw(
          sshHost,
          sshUser,
          `docker container inspect --format '{{.Config.Image}}' ${q} 2>/dev/null`,
        );
        const imageTag = before.code === 0 ? before.stdout.trim() : "";
        await sshExecRaw(
          sshHost,
          sshUser,
          `docker stop ${q} 2>/dev/null; docker rm ${q} 2>/dev/null; true`,
        );
        log(`Container '${containerName}' stopped`);
        context.logger.info("Container {name} stopped", {
          name: containerName,
        });

        const handle = await context.writeResource("container", containerName, {
          containerName,
          imageTag,
          running: false,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    inspect: {
      description: "Inspect a Docker container",
      arguments: z.object({
        containerName: ContainerName,
      }),
      execute: async (args: { containerName: string }, context: Ctx) => {
        const { sshHost, sshUser } = target(context);
        const { containerName } = args;
        if (!CONTAINER_NAME_RE.test(containerName)) {
          throw new Error(`Invalid containerName '${containerName}'`);
        }
        const logs: string[] = [];
        const log = (msg: string) => logs.push(msg);

        context.logger.info("Inspecting container {name} on {host}", {
          name: containerName,
          host: sshHost,
        });
        log(`Inspecting container '${containerName}' on ${sshHost}`);
        const result = await sshExecRaw(
          sshHost,
          sshUser,
          `docker container inspect --format '{{.State.Running}} {{.Id}} {{.Config.Image}}' ${
            shellQuote(containerName)
          } 2>/dev/null`,
        );

        if (result.code !== 0) {
          log(`Container '${containerName}' not found`);
          context.logger.info("Container {name} not found", {
            name: containerName,
          });
          const handle = await context.writeResource(
            "container",
            containerName,
            {
              containerName,
              imageTag: "",
              running: false,
              logs: logs.join("\n"),
              timestamp: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        }

        const { running, containerId, imageTag } = parseInspectOutput(
          result.stdout,
        );
        log(
          `Container '${containerName}': running=${running}, id=${
            containerId.slice(0, 12)
          }, image=${imageTag}`,
        );
        context.logger.info("Container {name} running={running}", {
          name: containerName,
          running,
        });

        const handle = await context.writeResource("container", containerName, {
          containerName,
          imageTag,
          running,
          containerId,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    exec: {
      description: "Execute a command inside a running Docker container",
      arguments: z.object({
        containerName: ContainerName,
        command: z.string().min(1).describe(
          "Command to execute (passed to the remote shell as-is)",
        ),
        workdir: z.string().optional().describe(
          "Working directory inside the container",
        ),
      }),
      execute: async (
        args: { containerName: string; command: string; workdir?: string },
        context: Ctx,
      ) => {
        const { sshHost, sshUser } = target(context);
        const { containerName, command } = args;
        if (!CONTAINER_NAME_RE.test(containerName)) {
          throw new Error(`Invalid containerName '${containerName}'`);
        }
        const wdFlag = args.workdir ? ` -w ${shellQuote(args.workdir)}` : "";
        const logs: string[] = [];
        const log = (msg: string) => logs.push(msg);

        context.logger.info("Running command in {name} on {host}", {
          name: containerName,
          host: sshHost,
        });
        log(`Running command in '${containerName}' on ${sshHost}: ${command}`);
        const result = await sshExec(
          sshHost,
          sshUser,
          `docker exec${wdFlag} ${shellQuote(containerName)} ${command}`,
        );
        log(`Command completed`);
        log((result.stdout || result.stderr).trim());
        context.logger.info("Command completed in {name}", {
          name: containerName,
        });

        const handle = await context.writeResource("result", "result", {
          success: true,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
