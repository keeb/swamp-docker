import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20261014.55";
import {
  composeCmd,
  evaluateHealth,
  model,
  parseCaptured,
  parsePs,
  serviceSuffix,
} from "./docker_compose.ts";

const HOST = "192.0.2.20";
const base = {
  sshHost: HOST,
  sshUser: "root",
  composePath: "/srv/stack",
  pruneOnUpdate: false,
  rollbackOnUpdate: false,
  updateHealthTimeout: 30,
};

const remote = (args: string[]) => args[args.length - 1];

// deno-lint-ignore no-explicit-any
const m = model.methods as any;

Deno.test("composeCmd quotes the path and validates services", () => {
  assertEquals(
    composeCmd("/srv/stack", undefined, "up -d"),
    "cd '/srv/stack' && docker compose up -d",
  );
  assertEquals(
    composeCmd("~/stack", "web db", "pull"),
    "cd ~/'stack' && docker compose pull web db",
  );
  assertThrows(() => serviceSuffix("web;reboot"), Error, "Invalid serviceName");
  assertThrows(() => composeCmd("", undefined, "ps"), Error, "composePath");
});

Deno.test("parsePs handles arrays, JSON lines and garbage", () => {
  assertEquals(parsePs(""), []);
  assertEquals(parsePs("null"), []);
  assertEquals(parsePs("[null, 5]"), []);
  assertEquals(parsePs('[{"Service":"a"}]'), [{ Service: "a" }]);
  assertEquals(parsePs('{"Service":"a"}\n{"Service":"b"}\nnot json'), [
    { Service: "a" },
    { Service: "b" },
  ]);
});

Deno.test("evaluateHealth classifies snapshots", () => {
  assertEquals(evaluateHealth([]).status, "waiting");
  assertEquals(
    evaluateHealth([{ Service: "a", State: "running", Health: "" }]).status,
    "ready",
  );
  assertEquals(
    evaluateHealth([{ Service: "a", State: "running", Health: "healthy" }])
      .status,
    "ready",
  );
  assertEquals(
    evaluateHealth([{ Service: "a", State: "running", Health: "starting" }]),
    { status: "waiting", reason: "a health=starting" },
  );
  assertEquals(
    evaluateHealth([
      { Service: "a", State: "restarting" },
      { Service: "b", State: "exited" },
    ]),
    { status: "terminal", reason: "b state=exited" },
  );
  assertEquals(
    evaluateHealth([{ Service: "a", State: "running", Health: "unhealthy" }])
      .status,
    "terminal",
  );
});

Deno.test("parseCaptured splits ref and sha", () => {
  assertEquals(parseCaptured("repo:1|sha256:aa\nrepo@sha256:bb|sha256:bb\n"), [
    { ref: "repo:1", sha: "sha256:aa" },
    { ref: "repo@sha256:bb", sha: "sha256:bb" },
  ]);
});

Deno.test("model declares a no-op upgrade to its current version", () => {
  const last = model.upgrades[model.upgrades.length - 1];
  assertEquals(last.toVersion, model.version);
  assertEquals(last.upgradeAttributes({ composePath: "/x" }), {
    composePath: "/x",
  });
});

Deno.test("start runs compose up and records output", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...base, serviceName: "web" },
  });
  const { calls } = await withMockedCommand(
    () => ({ stdout: "started", code: 0 }),
    () => m.start.execute({}, context),
  );
  assertEquals(
    remote(calls[0].args),
    "cd '/srv/stack' && docker compose up -d web",
  );
  assertEquals(getWrittenResources()[0].data.output, "started");
});

Deno.test("stop failure throws and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: base,
  });
  await assertRejects(
    () =>
      withMockedCommand(
        () => ({ stdout: "", stderr: "no such directory", code: 1 }),
        () => m.stop.execute({}, context),
      ),
    Error,
    "no such directory",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("status and prune record command output", async () => {
  const s = createModelTestContext({ globalArgs: base });
  await withMockedCommand(
    () => ({ stdout: "NAME STATUS", code: 0 }),
    () => m.status.execute({}, s.context),
  );
  assertEquals(s.getWrittenResources()[0].data.output, "NAME STATUS");

  const p = createModelTestContext({ globalArgs: base });
  const { calls } = await withMockedCommand(
    () => ({ stdout: "Total reclaimed space: 0B", code: 0 }),
    () => m.prune.execute({}, p.context),
  );
  assertEquals(remote(calls[0].args), "docker image prune -f");
});

Deno.test("invalid global args are rejected before ssh runs", async () => {
  for (
    const globalArgs of [
      { ...base, sshHost: "-oProxyCommand=x" },
      { ...base, composePath: "" },
      { ...base, serviceName: "a&&b" },
      { ...base, updateHealthTimeout: -1 },
    ]
  ) {
    const { context } = createModelTestContext({ globalArgs });
    const { calls } = await withMockedCommand(
      () => ({ stdout: "", code: 0 }),
      () => assertRejects(() => m.update.execute({}, context)),
    );
    assertEquals(calls.length, 0);
  }
});

Deno.test("update without rollback pulls, ups and prunes", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...base, pruneOnUpdate: true },
  });
  const { calls } = await withMockedCommand(
    () => ({ stdout: "ok", code: 0 }),
    () => m.update.execute({}, context),
  );
  const cmds = calls.map((c) => remote(c.args));
  assertEquals(cmds, [
    "cd '/srv/stack' && docker compose pull",
    "cd '/srv/stack' && docker compose up -d",
    "docker image prune -f",
  ]);
  assertEquals(getWrittenResources()[0].data.success, true);
});

/** Fake remote host for the rollback-protected update path. */
function host(opts: { upFails?: boolean; psState: string }) {
  let ups = 0;
  return (_cmd: string, args: string[]) => {
    const r = remote(args);
    if (r.endsWith("ps -q")) return { stdout: "c1\n", code: 0 };
    if (r.startsWith("docker inspect")) {
      return { stdout: "repo/app:latest|sha256:old\n", code: 0 };
    }
    if (r.endsWith("pull")) return { stdout: "pulled", code: 0 };
    if (r.endsWith("up -d")) {
      ups++;
      if (opts.upFails && ups === 1) {
        return { stdout: "", stderr: "port in use", code: 1 };
      }
      return { stdout: "up", code: 0 };
    }
    if (r.includes("ps --format json")) {
      return {
        stdout: JSON.stringify([{ Service: "app", State: opts.psState }]),
        code: 0,
      };
    }
    if (r.startsWith("docker tag")) return { stdout: "", code: 0 };
    if (r.startsWith("docker image prune")) return { stdout: "", code: 0 };
    return { stdout: "", stderr: `unexpected: ${r}`, code: 99 };
  };
}

Deno.test("update with rollback succeeds when healthy", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...base, rollbackOnUpdate: true, pruneOnUpdate: true },
  });
  const { calls } = await withMockedCommand(
    host({ psState: "running" }),
    () => m.update.execute({}, context),
  );
  const cmds = calls.map((c) => remote(c.args));
  assert(!cmds.some((c) => c.startsWith("docker tag")));
  assertEquals(cmds[cmds.length - 1], "docker image prune -f");
  assertStringIncludes(
    String(getWrittenResources()[0].data.output),
    "Health gate passed",
  );
});

Deno.test("update rolls back when the health gate fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...base, rollbackOnUpdate: true, pruneOnUpdate: true },
  });
  const cmds: string[] = [];
  const handler = host({ psState: "exited" });
  await assertRejects(
    () =>
      withMockedCommand((cmd, args) => {
        cmds.push(remote(args));
        return handler(cmd, args);
      }, () => m.update.execute({}, context)),
    Error,
    "rolled back to the previous images",
  );
  assert(cmds.includes("docker tag 'sha256:old' 'repo/app:latest'"));
  assert(!cmds.includes("docker image prune -f"), "must not prune on failure");
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("update rolls back when up -d fails", async () => {
  const { context } = createModelTestContext({
    globalArgs: { ...base, rollbackOnUpdate: true },
  });
  await assertRejects(
    () =>
      withMockedCommand(
        host({ upFails: true, psState: "running" }),
        () => m.update.execute({}, context),
      ),
    Error,
    "port in use",
  );
});

Deno.test("update reports when nothing could be rolled back", async () => {
  const { context } = createModelTestContext({
    globalArgs: { ...base, rollbackOnUpdate: true },
  });
  await assertRejects(
    () =>
      withMockedCommand((cmd, args) => {
        if (remote(args).endsWith("ps -q")) return { stdout: "", code: 0 };
        return host({ psState: "dead" })(cmd, args);
      }, () => m.update.execute({}, context)),
    Error,
    "nothing was rolled back",
  );
});

Deno.test("valid-compose-target check passes and fails", async () => {
  const check = model.checks["valid-compose-target"];
  assertEquals(await check.execute({ globalArgs: base }), { pass: true });
  const bad = await check.execute({
    globalArgs: { ...base, serviceName: "x;y" },
  });
  assertEquals(bad.pass, false);
});
