# ThingLinks Edge

![ThingLinks Edge logo](https://raw.githubusercontent.com/mqttsnet/thinglinks-edge/main/docs/images/brand/logo.png)

**Edge computing gateway — one machine on site, one `docker compose up`.**

ThingLinks Edge runs and supervises multiple isolated **Node-RED** instances on a single
on-site box: provisioning, a built-in reverse proxy, passwordless editor entry,
three-layer health probes, backup/restore, and a web console — with one management entry.

[Source](https://github.com/mqttsnet/thinglinks-edge) ·
[中文文档](https://github.com/mqttsnet/thinglinks-edge/blob/main/README.zh-CN.md) ·
[Changelog](https://github.com/mqttsnet/thinglinks-edge/tree/main/changelogs) ·
Apache-2.0

---

## Quick start

The image contains the complete Manager and web console. Use this release's
`docker-compose.yml` to prepare its restricted Docker endpoint, persistent data and default Node-RED image automatically.

1. Download the matching [docker-compose.yml](https://github.com/mqttsnet/thinglinks-edge/blob/main/docker-compose.yml) into a dedicated directory. Use the Compose file shipped with your chosen image version.
2. Fill in the access URL and a chosen administrator password (at least 12 characters) at the top.
3. Run:

```bash
docker compose up -d
```

Open the configured URL and log in as **admin** with that password. No source checkout,
Node.js installation, `.env`, manual key generation, Docker group lookup or separate Node-RED pull is needed.
A new deployment without a valid password does not open the listener; existing accounts are not reset during upgrades.
Put the password in the quoted `x-initial-password` scalar; escape `$` as `$$` according to Compose syntax.
Keep the configuration file private.

### After the first login

1. Create a Node-RED instance from **Instances** and open its editor through the console.
2. Prepare and approve the node packages required by your protocol.
3. Choose a protocol template, configure the device and points, then deploy it to the selected instance.
4. Check **Field devices** and **Health**. Configure **Cloud** when cloud integration is required.

The management entry is port **19100** by default. Node-RED editors do not require a separately exposed 1880 port.
Use the configured public URL in your browser; reverse-proxy deployments must keep that URL and path consistent.

### Upgrading

```bash
# edit MANAGER_IMAGE in .env to the new tag, then:
docker compose pull && docker compose up -d
```

Running Node-RED instances are **not** interrupted: they are sibling containers, not
children of the Manager. A production line should never have to stop collecting data
just because the management console is being upgraded.

---

## What you get

| Capability | Purpose |
| --- | --- |
| Node-RED instance management | Independent instances, resource limits, logs and editor access |
| Protocol templates | Device and point configuration with component dependency checks |
| Field inventory | Device records, point values, quality codes and update times |
| Health monitoring | Container, application and flow checks plus host resource trends |
| Node governance | Approved packages, offline package storage and installed inventory |
| Cloud connection | Gateway configuration, uplink aggregation, buffering and command receipts |
| Operations | User roles, instance permissions, backups, recovery and diagnostic exports |

### Product preview

Actual local demonstration screenshot. Device compatibility and protocol acceptance must be verified in the target environment.

![ThingLinks Edge protocol templates](https://raw.githubusercontent.com/mqttsnet/thinglinks-edge/main/docs/images/screenshots/edge-templates.jpg)

[More screenshots and the complete guide](https://github.com/mqttsnet/thinglinks-edge#product-tour)

## Supported platforms

| Image platform | Host architecture |
| --- | --- |
| `linux/amd64` | x86-64 servers, industrial PCs and gateways |
| `linux/arm64` | ARM64 servers and edge devices with a 64-bit operating system |

Docker selects the matching image automatically. Check the actual CPU, operating system and device drivers before field rollout.
32-bit ARM, LoongArch, RISC-V, Power and s390x are not currently published by ThingLinks Edge.
The current [official Node-RED image matrix](https://github.com/node-red/node-red-docker#image-variations) must also match the target platform;
Docker's ability to build for another platform does not establish support for the complete application stack.

## Runtime requirements

| Requirement | Guidance |
| --- | --- |
| Docker | Docker Engine 24+ with the Compose plugin |
| Architecture | `x86_64` or `aarch64` |
| Storage | A dedicated persistent data directory; allow space for instances, packages, history and buffering |
| Memory | Size for the actual number of instances and their flows; configure per-instance resource limits |
| Network | Reach the required image registry for online installation, or use an offline bundle |

Manager serves the frontend, runs as uid 1000 with a read-only root filesystem, and includes a health check.
No host installation of Node.js, MySQL or Redis is required for the standard container deployment.

### Rootless Docker

Point the compose stack at the rootless socket in `.env`:

```bash
DOCKER_SOCK=/run/user/1000/docker.sock
```

Find the socket your Docker actually uses with:

```bash
docker context inspect --format '{{.Endpoints.docker.Host}}'
```

## Tags

| Tag | Meaning |
| --- | --- |
| `1.0.1` | Explicit version tag. Use an image digest when you need to pin the exact image contents. |
| `1.0` | Latest patch on the 1.0 line — picks up fixes, never breaking changes |
| `latest` | Latest stable release. Convenient for a first try; a moving target on a site box |

Pre-release tags (`1.1.0-rc1`) never move `1.0`, `1.1` or `latest`.

---

## Configuration

These are optional advanced overrides in `.env`. Ordinary deployments edit only the URL and initial password at the top of the Compose file. Existing `.env` settings are preserved.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXTERNAL_URL` | `http://localhost:19100` in Compose | The address users reach this box at, e.g. `http://192.168.10.20:19100`. Every outward-facing URL, redirect and cookie policy is derived from it; the process never infers its own address from request headers. Include the path when it sits behind a corporate reverse proxy at a sub-path. |
| `MASTER_KEY` | *(empty)* | Legacy environment key. New deployments automatically generate a private key file; existing values preserve the encryption identity. |
| `MASTER_KEY_FILE` | `<EDGE_DATA_ROOT>/.master.key` | Persistent private key, generated only for a fresh deployment. Store it separately and securely; business backups exclude it. |
| `INITIAL_PASSWORD` | *(empty)* | Optional legacy environment override for the chosen initial admin password. New accounts require at least 12 characters; existing accounts are unchanged. |
| `ADMIN_SETUP_MODE` | `password` in Compose | Refuses fresh startup without the chosen password. `browser` retains legacy local/trusted-network browser setup. |
| `EDGE_DATA_ROOT` | `/data01/mqttsnet/thinglinks-edge` | Host persistence root. The Manager database and every instance's `/data` live under it — one directory to back up, one to look at when troubleshooting. |
| `TZ` | `Asia/Shanghai` | Timezone for the Manager **and** every instance it creates. Node-RED's official image defaults to UTC; leaving this unset silently skews scheduled flows, shift logic and log timestamps. |
| `HOST_PORT` / `BIND_ADDR` | `19100` / `0.0.0.0` | Published port. Set `BIND_ADDR=127.0.0.1` when using a host reverse proxy. |
| `INSTANCE_PORT_MIN` / `MAX` | `30000` / `30999` | Host port range allocated to instances |
| `ALLOWED_IMAGE_TAGS` | `5.0.7-24-minimal,5.0.4-24-minimal,4.1.13-22-minimal` | Node-RED image tags instances may use — an allowlist, not a suggestion |
| `EDGE_METRICS_INTERVAL_SEC` | `10` | Health-trend sampling interval; `0` disables it. Samples are kept **in memory only** so the box's SD/eMMC card isn't written to every 10 seconds. |
| `ALLOWED_ORIGINS` | *(empty)* | Extra WebSocket/CORS origins, comma-separated |
| `UPDATE_CHECK_URL` | *(empty)* | Update checking is **off by default and never phones home**. Many sites have no internet, and industrial customers care about outbound connections. Set it explicitly to opt in. |
| `NODE_RED_BOOTSTRAP_IMAGE` | `nodered/node-red:5.0.7-24-minimal` | Image automatically prepared by Compose before Manager starts; offline packages select an image actually present in the bundle. |

---

## Data and persistence

Manager and instance data live under `EDGE_DATA_ROOT` on the host:

```
<EDGE_DATA_ROOT>/.master.key         private encryption key; preserve separately
<EDGE_DATA_ROOT>/manager/            Manager: SQLite, sessions, audit log
<EDGE_DATA_ROOT>/instances/<id>/     that instance's /data — flows.json, settings.js, installed nodes
```

This is a **bind mount, not a named volume** — `docker compose down -v` will *not* delete
it. Preserve the directory across upgrades. Business backups do not contain `.master.key`; keep that file separately and securely.
Existing data with a missing key is an error, not a reason to generate a new key.
See [backup and offline restore](https://github.com/mqttsnet/thinglinks-edge/blob/main/docs/guides/backup-restore.md) for the recovery scope and shutdown requirements.

## Security posture

- **The Manager never mounts the host Docker socket.** It reaches Docker only through a
  restricted proxy that allowlists a couple of dozen API paths by method and regex —
  the proxy limits API paths, while Manager validates platform ownership before lifecycle operations.
- **Runs as non-root** (uid 1000) on a **read-only root filesystem**, with
  `no-new-privileges`. The only writable paths are the data directory and a tmpfs.
- **Instances are isolated from each other** — each gets its own Docker network; a flow
  in one instance cannot reach another, even on the same box.
- **Container creation is allowlisted**, not filtered: an instance spec that isn't
  explicitly permitted is rejected rather than sanitized.

## Troubleshooting

```bash
docker compose ps -a
docker compose logs --tail=100 manager docker-proxy init-data node-red-image
```

- Manager should become **healthy**. The one-shot `init-data` and `node-red-image` services normally finish with exit code 0.
- If the console cannot be reached, check the configured URL, published port and host firewall.
- If a node cannot be installed, check both package availability and approval, then verify dependencies and the instance's applied policy.
- If image pulling fails, check registry connectivity or use the [offline installation guide](https://github.com/mqttsnet/thinglinks-edge/blob/main/scripts/offline/README.md).
- Keep passwords, tokens and private configuration out of public issue reports.

## Reporting problems

Issues and security reports: <https://github.com/mqttsnet/thinglinks-edge/issues>
