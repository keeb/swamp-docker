# @keeb/docker

[Swamp](https://github.com/systeminit/swamp) extension for Docker Engine and Docker Compose lifecycle management over SSH.

## Models

### `docker/engine`

Install Docker Engine and manage containers on a remote host.

| Method | Description |
|--------|-------------|
| `install` | Install Docker Engine on Alpine Linux |
| `build` | Build a Docker image from a Dockerfile |
| `run` | Run a container |
| `stop` | Stop a container |
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

- [@keeb/ssh](https://github.com/keeb/swamp-ssh) — SSH helpers (`lib/ssh.ts`)

## Install

```bash
swamp extension pull @keeb/docker
```

## License

MIT
