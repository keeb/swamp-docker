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
| `update` | Pull images and restart services |
| `status` | Check service status |

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

## License

MIT — see [LICENSE](./LICENSE).
