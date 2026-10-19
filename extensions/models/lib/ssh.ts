/**
 * SSH helpers shared across the docker extension models.
 *
 * Every remote operation runs through the local `ssh` client via
 * `Deno.Command`. The argument vector is fixed (three `-o` options, the
 * destination and the remote command string) and the destination is validated
 * by `assertSshTarget` before any process is spawned, so a host or user value
 * can never be interpreted as an `ssh` option.
 */

/** Hostname, IPv4 or IPv6 literal; never starts with `-`, no whitespace or `@`. */
const SSH_HOST_RE = /^[A-Za-z0-9_.:[\]%-]+$/;
/** POSIX-ish login name; never starts with `-`. */
const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/;

/** Result of a remote command. */
export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** True when `host` is a non-empty, usable SSH host value. */
export function isValidSshHost(host: unknown): host is string {
  if (!host) return false;
  if (typeof host !== "string") return false;
  if (host === "null" || host === "undefined") return false;
  if (host.startsWith("-")) return false;
  return SSH_HOST_RE.test(host);
}

/** True when `user` is a usable SSH login name. */
export function isValidSshUser(user: unknown): user is string {
  return typeof user === "string" && SSH_USER_RE.test(user);
}

/** Throw a descriptive error unless `host` and `user` are safe SSH values. */
export function assertSshTarget(host: unknown, user: unknown): void {
  if (!isValidSshHost(host)) {
    throw new Error(
      `Invalid sshHost ${
        JSON.stringify(host)
      }: expected a hostname or IP address (the VM must be running with an IP)`,
    );
  }
  if (!isValidSshUser(user)) {
    throw new Error(
      `Invalid sshUser ${JSON.stringify(user)}: expected a login name`,
    );
  }
}

/**
 * Quote a value for safe interpolation into a POSIX `sh` command line on the
 * remote host. The result is always a single word.
 */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Build the `ssh` argument vector for one remote command. */
export function buildSshArgs(
  ip: string,
  user: string,
  command: string,
): string[] {
  assertSshTarget(ip, user);
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Remote command must be a non-empty string");
  }
  return [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=10",
    `${user}@${ip}`,
    command,
  ];
}

/** Options for a remote command. */
export interface SshOptions {
  /**
   * Data written to the remote command's stdin. Use this for secrets so they
   * never appear in a process argument list on either host.
   */
  stdin?: string;
}

async function runSsh(
  ip: string,
  user: string,
  command: string,
  opts: SshOptions = {},
): Promise<SshResult> {
  const args = buildSshArgs(ip, user, command);
  const piped = opts.stdin !== undefined;
  // swamp-quality-ignore deno-command: ssh is the transport for every method; destination validated by assertSshTarget, documented in README
  const proc = new Deno.Command("ssh", {
    args,
    ...(piped ? { stdin: "piped", stdout: "piped", stderr: "piped" } : {}),
  });
  let result: Deno.CommandOutput;
  if (piped) {
    const child = proc.spawn();
    const writer = child.stdin.getWriter();
    let writeError: unknown;
    try {
      await writer.write(new TextEncoder().encode(opts.stdin));
      await writer.close();
    } catch (err) {
      // ssh exited before reading stdin; its exit code and stderr explain why.
      writeError = err;
    }
    result = await child.output();
    if (writeError && result.code === 0) throw writeError;
  } else {
    result = await proc.output();
  }
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  return { code: result.code, stdout, stderr };
}

/** Run `command` on the remote host; throws when it exits non-zero. */
export async function sshExec(
  ip: string,
  user: string,
  command: string,
  opts: SshOptions = {},
): Promise<SshResult> {
  const result = await runSsh(ip, user, command, opts);
  if (result.code !== 0) {
    throw new Error(
      `SSH command failed on ${user}@${ip} (exit ${result.code}): ${
        result.stderr.slice(-500)
      }`,
    );
  }
  return result;
}

/** Run `command` on the remote host and return its result whatever the exit code. */
export function sshExecRaw(
  ip: string,
  user: string,
  command: string,
): Promise<SshResult> {
  return runSsh(ip, user, command);
}

/** Poll until `echo ready` succeeds over SSH or `timeoutSeconds` elapses. */
export async function waitForSsh(
  ip: string,
  user: string,
  timeoutSeconds = 60,
  pollInterval = 3,
): Promise<boolean> {
  const deadline = Date.now() + (timeoutSeconds * 1000);

  while (Date.now() < deadline) {
    const result = await sshExecRaw(ip, user, "echo ready");
    if (result.code === 0 && result.stdout.trim() === "ready") {
      return true;
    }
    await new Promise((r) => setTimeout(r, pollInterval * 1000));
  }

  return false;
}
