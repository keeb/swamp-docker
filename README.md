# @keeb/docker

[Swamp](https://github.com/systeminit/swamp) extension for Docker Engine and Docker Compose lifecycle management over SSH.

## Models

### `docker/engine`

Install Docker Engine and manage containers on a remote host.

| Method | Description |
|--------|-------------|
| `install` | Install Docker Engine on Alpine Linux |
| `build` | Build a Docker image from a Dockerfile |
| `run` | Run a container (stops existing container with same name first) |
| `stop` | Stop and remove a container (idempotent) |
| `inspect` | Inspect a container |
| `exec` | Execute a command in a running container |

### `docker/compose`

Manage Docker Compose services on a remote host.

| Method | Description |
|--------|-------------|
| `start` | Start Compose services |
| `stop` | Stop Compose services |
| `update` | Pull images and restart services (optional health gate + rollback) |
| `status` | Check service status |
| `prune` | Remove dangling images |

## Workflows

| Workflow | Description |
|----------|-------------|
| `setup-docker` | Install Docker Engine on a running VM |

## Dependencies

- [@keeb/ssh](https://github.com/keeb/swamp-extensions) — SSH helpers (`lib/ssh.ts`)

## Install

```bash
swamp extension pull @keeb/docker
```

## Usage

Install Docker on a fresh Alpine VM, then run a container:

```bash
# Install docker + enable the service
swamp model method run my-host install

# Run nginx exposed on 8080
swamp model method run my-host run \
  --args containerName=web,imageTag=nginx:alpine,ports='["8080:80"]',restart=unless-stopped
```

Or manage a compose stack on the same host:

```bash
# Pull latest images and restart services in ~/stack
swamp model method run my-stack update
swamp model method run my-stack status
```

## Subprocess use and security

Every method runs on the remote host through the local OpenSSH client: the
extension spawns `ssh` with `Deno.Command` (in `extensions/models/lib/ssh.ts`).
There is no other subprocess. What it passes:

- A fixed argument vector: `-o StrictHostKeyChecking=no`,
  `-o UserKnownHostsFile=/dev/null`, `-o ConnectTimeout=10`, the destination
  `<sshUser>@<sshHost>`, and one remote command string.
- `sshHost` must look like a hostname or IP address and `sshUser` like a login
  name; neither may start with `-`. Invalid values are rejected before any
  process is spawned, so they can never be read as `ssh` options.
- Values interpolated into the remote command (container names, image tags,
  paths, ports, volumes, restart policy, service names, env entries) are
  single-quoted for `sh`. Container and service names must also match Docker's
  naming rules. A leading `~/` in a path is kept unquoted so it still expands.
- The `command` argument of `run` and `exec` is deliberately passed to the
  remote shell as written, because it is a command line for the container.
  Treat it like any shell command you would type on that host.
- Host-key checking is disabled because the target VMs are typically freshly
  provisioned. Only use this extension on networks you trust.
- `run` with `env` streams the variables over the SSH session's stdin (never in
  an argument list) into a temporary env file (`umask 077`) under `/tmp` on the
  remote host, and removes it once `docker run` returns.

Authentication uses whatever keys and `~/.ssh/config` your local `ssh` already
uses; the extension never handles passwords or key material.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
