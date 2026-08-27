<div align="center">

<a href="https://mqttsnet.com"><img src="./docs/images/logo.png" alt="ThingLinks" width="180"></a>

# ThingLinks Edge

**Edge Computing Gateway — One machine on site, one `docker compose up`**

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

[![Node.js](https://img.shields.io/badge/Node.js-24_LTS-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Docker Image](https://img.shields.io/docker/v/mqttsnet/thinglinks-edge?sort=semver&style=flat-square&logo=docker&logoColor=white&label=image&color=2496ED)](https://hub.docker.com/r/mqttsnet/thinglinks-edge)
[![Docker Pulls](https://img.shields.io/docker/pulls/mqttsnet/thinglinks-edge?style=flat-square&logo=docker&logoColor=white&color=2496ED)](https://hub.docker.com/r/mqttsnet/thinglinks-edge)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square)](LICENSE)

<br>

[![Website](https://img.shields.io/badge/Website-mqttsnet.com-blue?style=for-the-badge)](https://mqttsnet.com)
[![GitHub](https://img.shields.io/badge/GitHub-mqttsnet/thinglinks--edge-181717?style=for-the-badge&logo=github)](https://github.com/mqttsnet/thinglinks-edge)

</div>

---

## About

ThingLinks Edge is an **edge computing gateway platform** that runs on a single
machine at the customer site. Its purpose is **cloud-edge collaboration**: bring
field devices into the ThingLinks cloud, and bring cloud capabilities down to the
field — so that acquisition, buffering and local logic keep working when the link
to the cloud does not.

Multi-instance Node-RED hosting is **one capability**, not the whole product. It
is the slice being built out first.

## Core Features

| Feature | Description |
| --- | --- |
| **Instance Hosting** | Node-RED instances as sibling containers — upgrading the Manager never interrupts field acquisition |
| **Built-in Reverse Proxy** | Single entry point, single certificate; instance ports are never published, so authentication is uniform by construction |
| **Passwordless Editor Entry** | Open any instance editor from the console without re-entering instance credentials |
| **Three-layer Health Probes** | Container / application / flow, combined into one verdict that catches "process alive but not working" |
| **Network Isolation** | One network per instance — instances cannot reach each other |
| **Restricted Docker Endpoint** | The Manager never touches the host socket; every Docker call passes a per-method regex allowlist |
| **Runtime Mount Prefix** | One image serves `/` or any enterprise sub-path — no rebuild |
| **Cloud-Edge Collaboration** | Virtual gateway, sub-device registration, micro-batching, offline spool and replay *(in progress)* |

## Tech Stack

![Node.js](https://img.shields.io/badge/Node.js-24_LTS-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?style=flat-square&logo=sqlite&logoColor=white)
![Vue 3](https://img.shields.io/badge/Vue.js-3.5-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Naive UI](https://img.shields.io/badge/Naive%20UI-2.45-63E2B7?style=flat-square)
![Vite](https://img.shields.io/badge/Vite-8.x-646CFF?style=flat-square&logo=vite&logoColor=white)
![Node-RED](https://img.shields.io/badge/Node--RED-5.0-8F0000?style=flat-square&logo=nodered&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.x-F69220?style=flat-square&logo=pnpm&logoColor=white)

## Quick Start

### Requirements

| Component | Version |
| --- | --- |
| Docker Engine | 24+ with Compose v2 |
| Host architecture | `x86_64` or `aarch64` — 32-bit ARM is **not** supported |
| Node.js | 24 LTS (development only) |
| pnpm | 10.32+ (development only) |

> **32-bit ARM is not published.** The decisive reason is downstream: Node-RED's own
> official images for 5.x are `amd64`/`arm64` only, so an `armv7` Manager would be
> permanently stuck on Node-RED 4.1.x instances. Build-side costs compound it
> (`better-sqlite3` has no 32-bit ARM prebuilt binary), and the fit is poor anyway —
> genuinely 32-bit-only SoCs (i.MX6, AM335x, A20) ship with 256 MB–1 GB of RAM, while
> the Manager needs ~53 MiB and each instance ~104 MiB.
>
> **Raspberry Pi users are probably unaffected**: the Pi 3, 3B+ and Zero 2 W are all
> 64-bit-capable — only a 32-bit OS image puts them in the `armv7` bucket. Check with
> `uname -m`: `aarch64` works, `armv7l` does not.

### Deploy

The Manager image is published on Docker Hub as
[`mqttsnet/thinglinks-edge`](https://hub.docker.com/r/mqttsnet/thinglinks-edge) — a multi-arch manifest covering
`linux/amd64` and `linux/arm64`, so an x86 industrial PC and an ARM edge box run the
exact same command. Nothing is compiled on the site machine; it only needs Docker.

```bash
cp .env.example .env        # at minimum, set EXTERNAL_URL and MASTER_KEY
docker compose up -d
docker compose logs manager | grep '\[init\]'   # the initial password is printed once
```

Open `EXTERNAL_URL` in a browser — the console is served by the Manager itself.
`EXTERNAL_URL` is the single source of truth for every outward-facing URL, redirect
and cookie policy; the process never guesses its own external address.

To upgrade, point `MANAGER_IMAGE` in `.env` at the new tag, then
`docker compose pull && docker compose up -d`. Running Node-RED instances are **not**
interrupted — they are sibling containers, not children of the Manager. A production
line should never have to stop collecting data to upgrade the management console.

### Development

```bash
pnpm install

# terminal 1 — backend
cd apps/manager && pnpm build && \
  EXTERNAL_URL=http://localhost:5173 DATA_DIR=/tmp/tle-dev \
  MASTER_KEY=dev-key INITIAL_PASSWORD=initial-password-123 node dist/index.js

# terminal 2 — console
cd apps/web-console && pnpm dev      # http://localhost:5173
```

To run the full stack from your own build instead of the published image, layer the
build override on top of the deployment file:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

`docker-compose.yml` alone is pull-only by design — that is what a site machine uses.


## Project Structure

```
thinglinks-edge/
├── apps/
│   ├── manager/                  Control-plane service
│   │   ├── src/
│   │   │   ├── core/             Domain: config, crypto, db, auth, instances,
│   │   │   │                     ports, health, container spec, docker client
│   │   │   ├── http/             HTTP layer: app assembly, session, instances,
│   │   │   │                     SSO, reverse proxy, console hosting
│   │   │   └── index.ts          Entrypoint
│   │   ├── scripts/              Real-container verification suite
│   │   └── Dockerfile
│   └── web-console/              Console frontend (Vue 3 + TypeScript + Naive UI)
├── changelogs/                   One file per release
├── docker-compose.yml            Single-machine deployment
└── .env.example
```

## Verification

Every change must leave the full regression green. `pnpm verify` runs unit tests,
typecheck, build, and **11 real-container passes** against a live Docker daemon —
no mocked upstreams.

```bash
cd apps/manager && pnpm verify
```

| Suite | Covers |
| --- | --- |
| `verify-container-guard` | Container-creation whitelist enforced against real Docker |
| `verify-instance` | Instance creation, `settings.js` delivery, mount prefix — root and sub-path |
| `verify-proxy` | Reverse proxy, static assets, WebSocket, passwordless entry — root and sub-path |
| `verify-api` | Instance CRUD lifecycle and log decoding |
| `verify-health` | Three-layer probes |
| `verify-isolation` | Instance-to-instance network isolation |
| `verify-container` | Manager itself containerised — root and sub-path |
| `verify-compose` | Compose deployment, read-only rootfs, restricted Docker endpoint |

## Security

- Manager and instances both run **non-root** on a **read-only root filesystem**
- The Manager **never mounts the host Docker socket**; it reaches Docker only
  through a proxy that allowlists each endpoint by HTTP method
- **One network per instance** — instances cannot reach each other or the proxy
- Container creation passes a **hard whitelist**: no privileged mode, no host
  namespaces, only platform-managed named volumes, instance port never published
- A missing `MASTER_KEY` **refuses to start** rather than falling back to a default

See the [security baseline](CONTRIBUTING.md) for the incident behind each of these rules.

## Documentation

For deployment guides, API references and architecture documentation, visit
[mqttsnet.com](https://mqttsnet.com).

New to this codebase? Read [CONTRIBUTING.md](CONTRIBUTING.md) first — its engineering
discipline encodes every non-obvious behaviour we have already been bitten by.

## Contributing

See the [Contributor Guide](CONTRIBUTING.md). The engineering rules there are not
style preferences — each one exists because breaking it caused a silent bug.

## Contact

- Business Cooperation: [mqttsnet@163.com](mailto:mqttsnet@163.com)
- Issues: [GitHub Issues](https://github.com/mqttsnet/thinglinks-edge/issues)
- Pull Requests: [GitHub PRs](https://github.com/mqttsnet/thinglinks-edge/pulls)

> **Note:** This project is mirrored to multiple code hosting platforms. The **only
> official channel** for bug reports, feature requests and discussions is
> [GitHub Issues](https://github.com/mqttsnet/thinglinks-edge/issues).

## Acknowledgments

- [Node-RED](https://nodered.org) — Flow-based programming for the Internet of Things
- [Fastify](https://fastify.dev) — Fast and low overhead web framework

## License

ThingLinks Edge is licensed under the [Apache License 2.0](LICENSE).

---

<div align="center">

Copyright &copy; 2019-present [MqttsNet](https://mqttsnet.com). All rights reserved.

</div>
