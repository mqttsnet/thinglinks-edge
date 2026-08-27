# ThingLinks Edge

**Edge computing gateway — one machine on site, one `docker compose up`.**

ThingLinks Edge runs and supervises multiple isolated **Node-RED** instances on a single
on-site box: provisioning, a built-in reverse proxy, passwordless editor entry,
three-layer health probes, backup/restore, and a web console — all behind one port.

[Source](https://github.com/mqttsnet/thinglinks-edge) ·
[Changelog](https://github.com/mqttsnet/thinglinks-edge/blob/main/CHANGELOG.md) ·
Apache-2.0

---

## Supported platforms

Every tag is a multi-arch manifest, so the same command works everywhere — Docker
resolves the right image for the host.

| Platform | Typical hardware |
| --- | --- |
| `linux/amd64` | x86 industrial PCs, rack servers, VMs, NAS units, cloud instances |
| `linux/arm64` | ARM edge gateways, Raspberry Pi 4/5, Jetson, Rockchip/Allwinner boxes |

**32-bit ARM (`armv7`/`armhf`) is not supported, and cannot be.** Two independent
upstream limits: the official Node.js 24 images publish no 32-bit ARM build at all
(neither Alpine nor Debian variants), and `better-sqlite3` ships no 32-bit ARM
prebuilt binary. A Raspberry Pi therefore needs a **64-bit OS** — Raspberry Pi OS
(64-bit), Ubuntu Server arm64, or Debian arm64. Check with `uname -m`: `aarch64`
works, `armv7l` does not.

`s390x` and `ppc64le` are likewise not published — the base image has them, but
`better-sqlite3` has no prebuilt binary for either.

## Runtime requirements

| Requirement | Minimum | Why |
| --- | --- | --- |
| Docker Engine | 24+ | Older engines work for the image itself, but the deployment relies on Compose v2 semantics |
| Docker Compose | v2 | `depends_on: condition: service_completed_successfully` is a v2 feature; the data-root init step depends on it |
| Host arch | `x86_64` / `aarch64` | See above |
| Disk | ~340 MB for the image on disk, plus whatever your flows and instances need under `EDGE_DATA_ROOT` |

Verified to run under a **read-only root filesystem**, as **non-root** (uid 1000), and
with `no-new-privileges`. The image is Alpine-based (musl), carries `tzdata`, and ships
a built-in **`HEALTHCHECK`** — so `docker ps`, Portainer, Docker Swarm and
`depends_on: condition: service_healthy` all get a real answer instead of assuming
"the process hasn't exited, so it must be fine."

### Rootless Docker

Point the compose stack at the rootless socket in `.env`:

```bash
DOCKER_SOCK=/run/user/1000/docker.sock
DOCKER_GID=1000
```

Find the socket your Docker actually uses with:

```bash
docker context inspect --format '{{.Endpoints.docker.Host}}'
```

## Tags

| Tag | Meaning |
| --- | --- |
| `1.0.1` | An exact release. **Use this in production.** |
| `1.0` | Latest patch on the 1.0 line — picks up fixes, never breaking changes |
| `latest` | Latest stable release. Convenient for a first try; a moving target on a site box |

Pre-release tags (`1.1.0-rc1`) never move `1.0`, `1.1` or `latest`.

---

## Quick start

This image is **not meant to be run on its own with `docker run`**. The Manager creates
Node-RED instances as *sibling containers*, so it needs a Docker endpoint and a host data
directory wired up correctly. Compose does that wiring for you:

```bash
git clone https://github.com/mqttsnet/thinglinks-edge.git
cd thinglinks-edge
cp .env.example .env         # at minimum set EXTERNAL_URL and MASTER_KEY
docker compose up -d
docker compose logs manager | grep '\[init\]'   # the initial password is printed once
```

Then open `EXTERNAL_URL` in a browser. The console is served by the Manager itself —
there is no second container to deploy and no separate web server to configure.

Only `docker-compose.yml` and `.env` are actually needed at runtime; the clone is just
the most convenient way to get them.

### Upgrading

```bash
# edit MANAGER_IMAGE in .env to the new tag, then:
docker compose pull && docker compose up -d
```

Running Node-RED instances are **not** interrupted: they are sibling containers, not
children of the Manager. A production line should never have to stop collecting data
just because the management console is being upgraded.

---

## Configuration

Set these in `.env`. Only the first two are required — the process **refuses to start**
without them rather than falling back to a guess or a default secret.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXTERNAL_URL` | — **required** | The address users reach this box at, e.g. `http://192.168.10.20:19100`. Every outward-facing URL, redirect and cookie policy is derived from it; the process never infers its own address from request headers. Include the path when it sits behind a corporate reverse proxy at a sub-path. |
| `MASTER_KEY` | — **required** | Encryption key for stored instance credentials. Generate with `openssl rand -hex 32`. **Back it up with your data directory** — losing it makes stored credentials unrecoverable. |
| `EDGE_DATA_ROOT` | `/data01/mqttsnet/thinglinks-edge` | Host persistence root. The Manager database and every instance's `/data` live under it — one directory to back up, one to look at when troubleshooting. |
| `TZ` | `Asia/Shanghai` | Timezone for the Manager **and** every instance it creates. Node-RED's official image defaults to UTC; leaving this unset silently skews scheduled flows, shift logic and log timestamps. |
| `HOST_PORT` / `BIND_ADDR` | `19100` / `127.0.0.1` | Published port. Loopback-only by default — set `BIND_ADDR=0.0.0.0` to expose it directly, or put a reverse proxy in front. |
| `INSTANCE_PORT_MIN` / `MAX` | `30000` / `30999` | Host port range allocated to instances |
| `ALLOWED_IMAGE_TAGS` | `5.0.4-24-minimal,4.1.13-22-minimal` | Node-RED image tags instances may use — an allowlist, not a suggestion |
| `EDGE_METRICS_INTERVAL_SEC` | `10` | Health-trend sampling interval; `0` disables it. Samples are kept **in memory only** so the box's SD/eMMC card isn't written to every 10 seconds. |
| `ALLOWED_ORIGINS` | *(empty)* | Extra WebSocket/CORS origins, comma-separated |
| `UPDATE_CHECK_URL` | *(empty)* | Update checking is **off by default and never phones home**. Many sites have no internet, and industrial customers care about outbound connections. Set it explicitly to opt in. |
| `DOCKER_GID` | `0` | GID of `docker.sock`, used only by the restricted proxy. Find it with `stat -c '%g' /var/run/docker.sock`. |

---

## Data and persistence

Everything lives under `EDGE_DATA_ROOT` on the host:

```
<EDGE_DATA_ROOT>/manager/            Manager: SQLite, sessions, audit log
<EDGE_DATA_ROOT>/instances/<id>/     that instance's /data — flows.json, settings.js, installed nodes
```

This is a **bind mount, not a named volume** — `docker compose down -v` will *not* delete
it. To start truly from scratch you have to remove the directory yourself.

## Security posture

- **The Manager never mounts the host Docker socket.** It reaches Docker only through a
  restricted proxy that allowlists a couple of dozen API paths by method and regex —
  it cannot pull images, and it cannot touch containers it did not create.
- **Runs as non-root** (uid 1000) on a **read-only root filesystem**, with
  `no-new-privileges`. The only writable paths are the data directory and a tmpfs.
- **Instances are isolated from each other** — each gets its own Docker network; a flow
  in one instance cannot reach another, even on the same box.
- **Container creation is allowlisted**, not filtered: an instance spec that isn't
  explicitly permitted is rejected rather than sanitized.

## Reporting problems

Issues and security reports: <https://github.com/mqttsnet/thinglinks-edge/issues>
