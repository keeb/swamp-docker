import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { withMockedCommand } from "jsr:@swamp-club/swamp-testing@0.20261014.55";
import {
  buildSshArgs,
  isValidSshHost,
  isValidSshUser,
  shellQuote,
  sshExec,
  sshExecRaw,
} from "./ssh.ts";
import { withFakeCommand } from "./fake_command_test_util.ts";

Deno.test("isValidSshHost accepts hosts and rejects option-like values", () => {
  for (const h of ["192.0.2.1", "host.example.com", "2001:db8::1", "[::1]"]) {
    assertEquals(isValidSshHost(h), true, h);
  }
  for (
    const h of ["", null, undefined, "null", "-oProxyCommand=x", "a b", "u@h"]
  ) {
    assertEquals(isValidSshHost(h), false, String(h));
  }
});

Deno.test("isValidSshUser rejects option-like and odd names", () => {
  assertEquals(isValidSshUser("root"), true);
  assertEquals(isValidSshUser("deploy-bot"), true);
  assertEquals(isValidSshUser("-oFoo"), false);
  assertEquals(isValidSshUser("a b"), false);
});

Deno.test("shellQuote produces a single safe word", () => {
  assertEquals(shellQuote("plain"), "'plain'");
  assertEquals(shellQuote("it's; rm -rf /"), `'it'\\''s; rm -rf /'`);
});

Deno.test("buildSshArgs places destination and command last", () => {
  const args = buildSshArgs("192.0.2.1", "root", "echo hi");
  assertEquals(args.slice(-2), ["root@192.0.2.1", "echo hi"]);
  assertThrows(() => buildSshArgs("192.0.2.1", "root", ""), Error, "non-empty");
  assertThrows(() => buildSshArgs("-x", "root", "ls"), Error, "sshHost");
});

Deno.test("sshExec throws with stderr on failure; sshExecRaw does not", async () => {
  await withMockedCommand(
    () => ({ stdout: "", stderr: "denied", code: 255 }),
    async () => {
      await assertRejects(
        () => sshExec("192.0.2.1", "root", "ls"),
        Error,
        "exit 255",
      );
      const raw = await sshExecRaw("192.0.2.1", "root", "ls");
      assertEquals(raw.code, 255);
      assertEquals(raw.stderr, "denied");
    },
  );
});

Deno.test("sshExec pipes stdin and keeps it out of argv", async () => {
  const { calls } = await withFakeCommand(
    () => ({ stdout: "", code: 0 }),
    () => sshExec("192.0.2.1", "root", "cat > /tmp/x", { stdin: "S=1\n" }),
  );
  assertEquals(calls[0].stdin, "S=1\n");
  assertEquals(calls[0].args.includes("S=1\n"), false);
});

Deno.test("sshExec with stdin still throws on non-zero exit", async () => {
  await withFakeCommand(
    () => ({ stdout: "", stderr: "disk full", code: 1 }),
    () =>
      assertRejects(
        () => sshExec("192.0.2.1", "root", "cat > /tmp/x", { stdin: "x" }),
        Error,
        "disk full",
      ),
  );
});
