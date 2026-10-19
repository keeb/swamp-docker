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
  buildRunCommand,
  model,
  parseEnv,
  parseInspectOutput,
  parseStringList,
  remotePath,
} from "./docker_engine.ts";
import { withFakeCommand } from "./lib/fake_command_test_util.ts";

const HOST = "192.0.2.10";
const globalArgs = { sshHost: HOST, sshUser: "root" };

/** The remote shell command is the last ssh argument. */
const remote = (c: { args: string[] }) => c.args[c.args.length - 1];

// deno-lint-ignore no-explicit-any
const m = model.methods as any;

Deno.test("parseStringList accepts arrays, JSON arrays and single values", () => {
  assertEquals(parseStringList(undefined, "ports"), []);
  assertEquals(parseStringList(["80:80"], "ports"), ["80:80"]);
  assertEquals(parseStringList('["80:80","443:443"]', "ports"), [
    "80:80",
    "443:443",
  ]);
  assertEquals(parseStringList("8080:80", "ports"), ["8080:80"]);
});

Deno.test("parseStringList rejects malformed input", () => {
  assertThrows(() => parseStringList("[80:80", "ports"), Error, "JSON array");
  assertThrows(() => parseStringList("[1,2]", "volumes"), Error, "strings");
});

Deno.test("parseEnv validates names, shapes and newlines", () => {
  assertEquals(parseEnv(undefined), []);
  assertEquals(parseEnv('{"A":"1","B":2}'), [["A", "1"], ["B", "2"]]);
  assertThrows(() => parseEnv("{nope"), Error, "not valid JSON");
  assertThrows(() => parseEnv("[1]"), Error, "JSON object");
  assertThrows(() => parseEnv('{"BAD-NAME":"x"}'), Error, "not allowed");
  assertThrows(() => parseEnv('{"A":"x\\ny"}'), Error, "newline");
});

Deno.test("remotePath quotes but keeps ~/ expandable", () => {
  assertEquals(remotePath("/srv/app"), "'/srv/app'");
  assertEquals(remotePath("~/my app"), "~/'my app'");
  assertEquals(remotePath("a'b"), `'a'\\''b'`);
});

Deno.test("buildRunCommand quotes every value", () => {
  const cmd = buildRunCommand({
    containerName: "web",
    imageTag: "nginx:alpine",
    restart: "unless-stopped",
    ports: ["8080:80"],
    volumes: ["/data:/data"],
    envFilePath: "/tmp/web.env",
    command: "nginx -g 'daemon off;'",
  });
  assertEquals(
    cmd,
    "docker run -d --name 'web' --restart 'unless-stopped' -p '8080:80' " +
      "-v '/data:/data' --env-file '/tmp/web.env' 'nginx:alpine' " +
      "nginx -g 'daemon off;'",
  );
});

Deno.test("parseInspectOutput splits state, id and image", () => {
  assertEquals(parseInspectOutput("true abc123 nginx:alpine\n"), {
    running: true,
    containerId: "abc123",
    imageTag: "nginx:alpine",
  });
  assertEquals(parseInspectOutput(""), {
    running: false,
    containerId: "",
    imageTag: "",
  });
});

Deno.test("model declares a no-op upgrade to its current version", () => {
  const last = model.upgrades[model.upgrades.length - 1];
  assertEquals(last.toVersion, model.version);
  assertEquals(last.upgradeAttributes({ sshHost: HOST }), { sshHost: HOST });
});

Deno.test("install runs apk over ssh and records success", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { calls } = await withMockedCommand(
    () => ({ stdout: "ok", code: 0 }),
    () => m.install.execute({}, context),
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].command, "ssh");
  assert(calls[0].args.includes(`root@${HOST}`));
  assertStringIncludes(remote(calls[0]), "apk add docker");
  const [w] = getWrittenResources();
  assertEquals(w.specName, "result");
  assertEquals(w.data.success, true);
});

Deno.test("install fails on ssh error and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await assertRejects(
    () =>
      withMockedCommand(
        () => ({ stdout: "", stderr: "Connection refused", code: 255 }),
        () => m.install.execute({}, context),
      ),
    Error,
    "Connection refused",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("invalid sshHost is rejected before any process spawns", async () => {
  for (const sshHost of ["", "null", "-oProxyCommand=x", "a b"]) {
    const { context } = createModelTestContext({
      globalArgs: { sshHost, sshUser: "root" },
    });
    const { calls } = await withMockedCommand(
      () => ({ stdout: "", code: 0 }),
      () =>
        assertRejects(() => m.install.execute({}, context), Error, "sshHost"),
    );
    assertEquals(calls.length, 0);
  }
});

Deno.test("build quotes tag, dockerfile and context", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { calls } = await withMockedCommand(
    () => ({ stdout: "built", code: 0 }),
    () =>
      m.build.execute({
        imageTag: "app:1",
        contextPath: "/srv/app",
        dockerfilePath: "Dockerfile.prod",
      }, context),
  );
  assertEquals(
    remote(calls[0]),
    "docker build -t 'app:1' -f 'Dockerfile.prod' '/srv/app'",
  );
  const [w] = getWrittenResources();
  assertEquals(w.specName, "image");
  assertEquals(w.name, "app:1");
  assertEquals(w.data.context, "/srv/app");
});

Deno.test("run sends env on stdin, runs, then removes the file", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { calls } = await withFakeCommand((call) => {
    if (remote(call).startsWith("docker run")) {
      return { stdout: "cid1234567890ab\n", code: 0 };
    }
    return { stdout: "", code: 0 };
  }, () =>
    m.run.execute({
      containerName: "web",
      imageTag: "nginx:alpine",
      ports: '["8080:80"]',
      env: '{"TOKEN":"it\'s secret"}',
    }, context));

  const cmds = calls.map(remote);
  assertEquals(cmds.length, 4);
  assertStringIncludes(cmds[0], "docker stop 'web'");
  assertEquals(
    cmds[1],
    "(umask 077 && rm -f '/tmp/web.env' && cat > '/tmp/web.env')",
  );
  assertEquals(calls[1].stdin, "TOKEN=it's secret\n");
  for (const c of calls) {
    assert(!c.args.join(" ").includes("secret"), "secret leaked into argv");
  }
  assertStringIncludes(cmds[2], "--env-file '/tmp/web.env'");
  assertStringIncludes(cmds[2], "-p '8080:80'");
  assertEquals(cmds[3], "rm -f '/tmp/web.env'");
  const [w] = getWrittenResources();
  assertEquals(w.data.running, true);
  assertEquals(w.data.containerId, "cid1234567890ab");
});

Deno.test("run removes the temp env file even when docker run fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const cmds: string[] = [];
  await assertRejects(
    () =>
      withFakeCommand((call) => {
        cmds.push(remote(call));
        if (remote(call).startsWith("docker run")) {
          return { stdout: "", stderr: "no such image", code: 125 };
        }
        return { stdout: "", code: 0 };
      }, () =>
        m.run.execute({
          containerName: "web",
          imageTag: "missing:tag",
          env: '{"A":"1"}',
        }, context)),
    Error,
    "no such image",
  );
  assertEquals(cmds[cmds.length - 1], "rm -f '/tmp/web.env'");
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("run validates inputs before stopping the old container", async () => {
  const { context } = createModelTestContext({ globalArgs });
  const { calls } = await withMockedCommand(
    () => ({ stdout: "", code: 0 }),
    () =>
      assertRejects(
        () =>
          m.run.execute({
            containerName: "web",
            imageTag: "nginx",
            env: "{broken",
          }, context),
        Error,
        "Invalid env",
      ),
  );
  assertEquals(calls.length, 0);
});

Deno.test("run rejects a container name docker would refuse", async () => {
  const { context } = createModelTestContext({ globalArgs });
  await assertRejects(
    () =>
      m.run.execute({ containerName: "web; rm -rf /", imageTag: "x" }, context),
    Error,
    "Invalid containerName",
  );
});

Deno.test("stop records the image and is idempotent", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedCommand((_cmd, args) => {
    const r = args[args.length - 1];
    if (r.startsWith("docker container inspect")) {
      return { stdout: "nginx:alpine\n", code: 0 };
    }
    return { stdout: "", code: 0 };
  }, () => m.stop.execute({ containerName: "web" }, context));
  const [w] = getWrittenResources();
  assertEquals(w.data.running, false);
  assertEquals(w.data.imageTag, "nginx:alpine");
});

Deno.test("inspect reports a missing container as not running", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedCommand(
    () => ({ stdout: "", stderr: "No such object", code: 1 }),
    () => m.inspect.execute({ containerName: "ghost" }, context),
  );
  const [w] = getWrittenResources();
  assertEquals(w.data.running, false);
  assertEquals(w.data.imageTag, "");
});

Deno.test("inspect parses a running container", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedCommand(
    () => ({ stdout: "true deadbeef nginx:alpine\n", code: 0 }),
    () => m.inspect.execute({ containerName: "web" }, context),
  );
  const [w] = getWrittenResources();
  assertEquals(w.data.running, true);
  assertEquals(w.data.containerId, "deadbeef");
});

Deno.test("exec quotes container and workdir, passes command through", async () => {
  const { context } = createModelTestContext({ globalArgs });
  const { calls } = await withMockedCommand(
    () => ({ stdout: "hi", code: 0 }),
    () =>
      m.exec.execute({
        containerName: "web",
        command: "echo hi",
        workdir: "/app",
      }, context),
  );
  assertEquals(remote(calls[0]), "docker exec -w '/app' 'web' echo hi");
});

Deno.test("exec surfaces a non-zero exit", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await assertRejects(
    () =>
      withMockedCommand(
        () => ({ stdout: "", stderr: "container not running", code: 1 }),
        () => m.exec.execute({ containerName: "web", command: "ls" }, context),
      ),
    Error,
    "container not running",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("valid-ssh-target check passes and fails", async () => {
  const check = model.checks["valid-ssh-target"];
  assertEquals(await check.execute({ globalArgs }), { pass: true });
  const bad = await check.execute({
    globalArgs: { sshHost: "-oProxyCommand=x", sshUser: "root" },
  });
  assertEquals(bad.pass, false);
});
