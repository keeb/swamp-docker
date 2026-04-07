---
name: docker
description: Manage Docker Engine and Docker Compose on remote hosts over SSH via the @keeb/docker swamp extension. Use when working with the `@user/docker/engine` or `@user/docker/compose` model types, installing Docker on an Alpine VM, building images, running/stopping/inspecting/execing containers, or starting/stopping/updating/checking status of Compose services. Triggers on "docker engine", "docker compose", "install docker", "docker build", "docker run", "docker exec", "compose up", "compose down", "dockerEngine", "dockerCompose", or editing YAML definitions that reference `@user/docker/engine` / `@user/docker/compose`.
---

# docker

`@keeb/docker` is a swamp extension that manages Docker Engine and Docker
Compose lifecycles on remote hosts over SSH. All operations shell out to `ssh`
on the machine running swamp — there is no Docker API client. The target host is
expected to be Alpine Linux for `install`.

## Models

### `@user/docker/engine`

Install Docker Engine and manage containers on a remote host.

- **Global arguments**
  - `sshHost` (string, required) — SSH hostname/IP of the target VM
  - `sshUser` (string, default `root`) — SSH user
- **Resources**
  - `result` — generic operation result (`success`, `logs`, `timestamp`)
  - `image` — built image (`imageTag`, `context`, `logs`, `timestamp`)
  - `container` — container state (`containerName`, `imageTag`, `running`,
    `containerId`, `logs`, `timestamp`)
- **Methods**
  - `install` —
    `apk add docker && rc-update add docker default && service
    docker start`.
    Alpine only. No arguments.
  - `build` — `docker build -t <imageTag> [-f <dockerfilePath>] <contextPath>`.
    Arguments: `imageTag`, `contextPath`, optional `dockerfilePath`. Writes an
    `image` resource named after `imageTag`.
  - `run` — Idempotent: stops and removes any existing container with the same
    name first, then `docker run -d --name <containerName> ...`. Arguments:
    `containerName`, `imageTag`, optional `ports` (array or JSON string),
    `volumes` (array or JSON string), `env` (JSON object string), `envFile`
    (path on remote), `restart`, `command`. Writes a `container` resource named
    after `containerName`.
  - `stop` — Idempotent `docker stop && docker rm`. Arguments: `containerName`.
    Writes a `container` resource with `running: false`.
  - `inspect` — Reads container state via `docker inspect --format`. Arguments:
    `containerName`. Writes a `container` resource (with `running: false` if the
    container is missing — method still succeeds).
  - `exec` — `docker exec [-w <workdir>] <containerName> <command>`. Arguments:
    `containerName`, `command`, optional `workdir`. Writes a `result` resource.

### `@user/docker/compose`

Manage Docker Compose services on a remote host. All methods take no per-method
arguments — behavior is driven entirely by global arguments.

- **Global arguments**
  - `sshHost` (string, required)
  - `sshUser` (string, default `root`)
  - `composePath` (string, required) — path to the compose directory on the
    remote host
  - `serviceName` (string, optional) — scope operations to a single service.
    Omit to operate on all services.
- **Resources**
  - `result` — `success`, `output`, `timestamp`
- **Methods**
  - `start` — `cd <composePath> && docker compose up -d [<serviceName>]`
  - `stop` —
    `cd <composePath> && docker compose down [<serviceName>] &&
    sleep 3`
  - `update` — `docker compose pull` then `docker compose up -d` (scoped by
    `serviceName` if set)
  - `status` — `docker compose ps [<serviceName>]`

## Dependencies

Requires `@keeb/ssh` (listed in `manifest.yaml`). SSH helpers (`sshExec`,
`sshExecRaw`, `isValidSshHost`) come from `extensions/models/lib/ssh.ts` and
shell out to the system `ssh` binary with `StrictHostKeyChecking=no` and a
10-second connect timeout. The host running swamp needs an SSH key that the
target accepts.

## Common patterns

### Creating a docker engine model

```yaml
name: dockerEngine
type: "@user/docker/engine"
globalArguments:
  sshHost: ${{ data.latest("fleet", "vm-web01").attributes.ip }}
  sshUser: root
```

Wire `sshHost` from another model (e.g. a VM lookup) using CEL rather than
hard-coding IPs.

### Creating a docker compose model

```yaml
name: webCompose
type: "@user/docker/compose"
globalArguments:
  sshHost: ${{ data.latest("fleet", "vm-web01").attributes.ip }}
  composePath: /opt/web
  # serviceName: api   # optional — omit to operate on the whole stack
```

### Running a container with env and ports

```bash
swamp model exec dockerEngine run \
  --containerName web \
  --imageTag ghcr.io/acme/web:latest \
  --ports '["8080:8080"]' \
  --env '{"DATABASE_URL":"postgres://..."}' \
  --restart unless-stopped
```

`ports`, `volumes`, and `env` accept either arrays/objects or JSON-encoded
strings — the model `JSON.parse`s strings at runtime.

### Referencing results via CEL

```yaml
imageTag: ${{ data.latest("dockerEngine", "myImage").attributes.imageTag }}
running: ${{ data.latest("dockerEngine", "web").attributes.running }}
```

Prefer `data.latest(<modelName>, <dataName>)` over the deprecated
`model.<name>.resource.<spec>.<instance>.attributes.<field>` pattern. The
`dataName` matches what the method writes: `result` for `install`/`exec`,
`<imageTag>` for `build`, and `<containerName>` for `run`/`stop`/`inspect`.

### Workflow example (`setup-docker`)

Shipped with the extension. Takes `vmName`, authenticates with Proxmox, looks up
the VM via `fleet`, then calls `dockerEngine install`. Pattern to copy when
chaining auth + lookup + install.

## Gotchas

- **Alpine-only `install`.** `apk add docker` is hard-coded. Do not call
  `install` against Debian/Ubuntu/RHEL — it will fail. For other distros, add a
  new method rather than working around it.
- **Host key checking is disabled.** `sshExec` passes
  `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`. This is a
  deliberate trade-off for ephemeral VMs — do not "fix" it without talking to
  the extension owner.
- **`sshExec` throws on non-zero exit; `sshExecRaw` does not.** `stop`,
  `inspect`, and `run`'s pre-cleanup use `sshExecRaw` so missing containers
  don't abort the method. Preserve this when editing.
- **Compose `serviceName` is global, not per-method.** To operate on different
  services from the same workflow, create separate compose models (one per
  service) rather than trying to override per call.
- **`run` is destructive.** It unconditionally `docker stop && docker rm`s any
  existing container with the same name before starting. Safe for redeploys,
  surprising if you forgot.
- **`stop` writes an empty `imageTag`.** The resulting `container` resource has
  `imageTag: ""` — don't read it back expecting the old image.
- **`env` must be a JSON _object string_, not `KEY=VALUE` lines.** The model
  parses it with `JSON.parse` and writes `/tmp/<containerName>.env`. If you
  already have an env file on the remote host, pass `envFile` instead and `env`
  will be ignored.
- **Idempotent is not graceful.** `docker stop` is not given a `-t` flag;
  containers that ignore SIGTERM will get SIGKILL after Docker's default 10s.
- **SSH credentials are implicit.** There is no vault integration — auth is
  whatever `ssh` on the swamp host already has configured (agent, key files,
  etc.).

## Verification before destructive ops

Before calling `stop` or re-running `run` on a container you care about:

```bash
swamp model get dockerEngine --json
```

Confirm the `containerName` / `containerId` matches what you expect.
