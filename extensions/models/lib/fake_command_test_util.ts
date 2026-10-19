// Test-only helper (not imported by any model, so never packaged): replaces
// Deno.Command with a fake that supports both output() and spawn() with piped
// stdin, which withMockedCommand does not.

/** One recorded fake invocation. */
export interface FakeCall {
  command: string;
  args: string[];
  stdin?: string;
}

/** Fake reply for one invocation. */
export interface FakeReply {
  stdout?: string;
  stderr?: string;
  code: number;
}

/** Run `fn` with Deno.Command faked by `handler`; returns the recorded calls. */
export async function withFakeCommand<T>(
  handler: (call: FakeCall) => FakeReply,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: FakeCall[] }> {
  const calls: FakeCall[] = [];
  const enc = new TextEncoder();
  const toOutput = (r: FakeReply) => ({
    code: r.code,
    success: r.code === 0,
    signal: null,
    stdout: enc.encode(r.stdout ?? ""),
    stderr: enc.encode(r.stderr ?? ""),
  });

  class FakeCommand {
    #call: FakeCall;
    constructor(command: string, options: { args?: string[] } = {}) {
      this.#call = { command, args: options.args ?? [] };
    }
    output() {
      calls.push(this.#call);
      return Promise.resolve(toOutput(handler(this.#call)));
    }
    spawn() {
      const call = this.#call;
      const chunks: Uint8Array[] = [];
      const stdin = new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        },
      });
      return {
        stdin,
        output: () => {
          call.stdin = new TextDecoder().decode(
            chunks.reduce((a, b) => {
              const out = new Uint8Array(a.length + b.length);
              out.set(a);
              out.set(b, a.length);
              return out;
            }, new Uint8Array()),
          );
          calls.push(call);
          return Promise.resolve(toOutput(handler(call)));
        },
      };
    }
  }

  const original = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = FakeCommand;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = original;
  }
}
