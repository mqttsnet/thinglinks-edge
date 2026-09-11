<div align="center">

<a href="https://mqttsnet.com"><img src="docs/images/brand/logo.png" alt="ThingLinks" width="180"></a>

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

[Quick start](#quick-start) · [Product tour](#product-tour) · [Workflow](#from-installation-to-operation) · [FAQ](#faq)

## About

ThingLinks Edge is an **edge computing gateway platform** that runs on a single
machine at the customer site. Its purpose is **cloud-edge collaboration**: bring
field devices into the ThingLinks cloud, and bring cloud capabilities down to the
field — so that acquisition, buffering and local logic keep working when the link
to the cloud does not.

ThingLinks cloud platform repository: [mqttsnet/thinglinks](https://github.com/mqttsnet/thinglinks).

Multi-instance Node-RED hosting is **one capability**, not the whole product. It
is the slice being built out first.

[![ThingLinks Edge product architecture](docs/images/architecture/edge-product.svg)](docs/images/architecture/edge-product.svg)

Select the diagram to view it at full size. Diagram labels are in Chinese. Candidate protocols and conditional capabilities are not delivery guarantees.

## Core Features

| Feature | Description |
| --- | --- |
| **Instance Hosting** | Independent Node-RED containers; a Manager upgrade does not automatically restart instances |
| **Built-in Reverse Proxy** | One authenticated management/editor entry; application ports are configured per instance |
| **Passwordless Editor Entry** | Open any instance editor from the console without re-entering instance credentials |
| **Three-layer Health Probes** | Container / application / flow, combined into one verdict that catches "process alive but not working" |
| **Network Isolation** | One network per instance — instances cannot reach each other |
| **Restricted Docker Endpoint** | The Manager never touches the host socket; every Docker call passes a per-method regex allowlist |
| **Runtime Mount Prefix** | One image serves `/` or any enterprise sub-path — no rebuild |
| **Cloud-Edge Collaboration** | Virtual gateway, sub-device registration, micro-batching, offline spool and replay — configured from the console, applied without a restart |
| **Field Inventory** | Devices, current point values, quality codes and update timestamps reported by ThingLinks nodes |
| **Protocol Templates** | Protocol filtering, device and point parameters, dependency checks and instance deployment |
| **Node Governance** | Approvals, offline packages, installed inventory and platform-node migration |
| **Operations** | User roles, instance permissions, backups, recovery and diagnostic exports |
| **Credentials Encrypted at Rest** | Stored instance and cloud credentials use application-level encryption; secrets are excluded from routine listings |

## Quick Start

### Requirements

| Component | Version |
| --- | --- |
| Docker Engine | 24+ with Compose v2 |
| Host architecture | `x86_64` or `aarch64` — 32-bit ARM is **not** supported |
| Node.js | 24 LTS (development only) |
| pnpm | 10.32+ (development only) |

### Deploy

The Manager image is published on Docker Hub as
[`mqttsnet/thinglinks-edge`](https://hub.docker.com/r/mqttsnet/thinglinks-edge) — a multi-arch manifest covering
`linux/amd64` and `linux/arm64`, so an x86 industrial PC and an ARM edge box run the
exact same command. Nothing is compiled on the site machine; it only needs Docker.

1. Download this release's [docker-compose.yml](docker-compose.yml) into a dedicated directory.
2. Fill in the two fields at the top: your access URL and a chosen administrator password of at least 12 characters. Put the password inside the quotes of `x-initial-password`; write `$` as `$$` in Compose.
3. Run in that directory:

```bash
docker compose up -d
```

Open that address and log in as **admin** with your chosen password, then create a Node-RED instance. A fresh deployment without a valid password does not open the listener. Upgrades with existing accounts neither require an initial password nor reset accounts.
No source checkout, Node.js installation, `.env`, manual encryption key, Docker group lookup, or separate default Node-RED pull is required.
Compose prepares the data directory and pulls all required images, including Node-RED 5.0.7.

The dedicated data root defaults to `/data01/mqttsnet/thinglinks-edge`. On first startup,
Manager creates `<data root>/.master.key` with mode 0600 and reuses it after restarts and upgrades.
**Keep the key file separately and securely; business backups do not contain it.** If data already exists
but its key is missing, startup fails instead of generating a replacement.

Port 19100 is published by default. Keep the configuration file private because it contains the initial password.
Use [.env.example](.env.example) only for advanced settings such as a reverse proxy, rootless Docker,
custom paths or offline operation. Existing `.env` files and `MASTER_KEY` values remain valid and keep
the same encryption identity. Other Node-RED versions still need their corresponding images prepared.

`EXTERNAL_URL` remains the source of truth for external URLs and cookie policy; it is not inferred from request headers.
To upgrade, explicitly select the new `MANAGER_IMAGE`, then run `docker compose pull && docker compose up -d`.
Existing Node-RED instances are independent containers and are not automatically restarted with Manager.

If you lose administrator access, use the existing host-side recovery tool:

```bash
node apps/manager/scripts/reset-admin.mjs admin
```

<details>
<summary>Deployment architecture: local, private cloud, public cloud and multiple sites</summary>

[![ThingLinks Edge deployment architecture](docs/images/architecture/edge-deployment.svg)](docs/images/architecture/edge-deployment.svg)

Each site runs its own Edge deployment and independent Node-RED instances. Multiple sites do not imply cross-host Manager failover. Default images are prepared automatically; retain the independent encryption key securely.

[Deployment details and boundaries (Chinese)](docs/architecture/deployment.md)

</details>

## Product tour

These real screenshots from the local demonstration environment show instance management, protocol configuration and operations. They retain their original capture state; none establishes field-device or cloud acceptance.

### Protocol templates

Filter acquisition recipes by protocol and category, inspect component requirements, and configure devices and points before deployment.
The screenshot shows the industrial acquisition category.

![ThingLinks Edge industrial protocol templates](docs/images/screenshots/edge-templates.jpg)

<details>
<summary>Instance management — status, resource limits and editor access</summary>

Inspect Node-RED versions, runtime status, memory and CPU allocations, then open an editor or instance logs from one place.

![ThingLinks Edge instance management](docs/images/screenshots/edge-instances.jpg)

</details>

<details>
<summary>Modbus-TCP configuration — connection, registers and acquisition points</summary>

This saved demonstration configuration includes the device address, port, unit ID, register type, read range and polling interval.

![Modbus-TCP device connection and register settings](docs/images/screenshots/edge-modbus-device-config.jpg)

The point table maps register offsets to model properties with data type, byte order, scaling and offset.
The shown `temperature` mapping, scale `0.1` and offset `1` come from the existing demonstration configuration; it was not changed or deployed for these screenshots.

![Modbus-TCP point and model-property mapping](docs/images/screenshots/edge-modbus-points.jpg)

</details>

<details>
<summary>Inside line-1 — Node-RED editor and ThingLinks nodes</summary>

Open the line-1 instance editor to view the flow canvas, the ThingLinks device/tag/uplink palette, and node help.
The canvas was empty when captured: these images demonstrate the editor and node panels, not a deployed acquisition flow.

![line-1 Node-RED editor and device node help](docs/images/screenshots/edge-line1-editor.jpg)

</details>

<details>
<summary>Health monitoring — host trends and three-layer instance checks</summary>

The view shows instance health counts and host resource trends, with line-1 running normally.

![ThingLinks Edge health monitoring](docs/images/screenshots/edge-health.jpg)

</details>

<details>
<summary>Node management — approvals, offline packages and installed inventory</summary>

Package availability and approval are separate. Prepare the required components, then apply policies to selected instances during a maintenance window.

![ThingLinks Edge node approvals](docs/images/screenshots/edge-nodes.jpg)

</details>

## Where it fits

- **Factory and production-line gateways**: keep acquisition flows in separate instances with their own resources and maintenance windows.
- **Building and campus integration**: normalize TCP, UDP, HTTP and industrial protocol data into field points before connecting to ThingLinks Cloud.
- **Shared edge hosts**: manage multiple projects with instance isolation, user roles and instance-specific permissions.
- **Restricted or offline sites**: prepare approved node packages and offline bundles, then buffer and replay uplink data according to configuration.

Edge handles field connectivity, flow execution and local operations. ThingLinks Cloud handles cloud-side business.
Device compatibility and protocol read/write behavior require validation in the target environment.

## From installation to operation

| Step | Console entry | What to verify |
| --- | --- | --- |
| 1. Deploy and sign in | Docker Compose, console | Manager is healthy and the administrator can sign in |
| 2. Create an instance | Instances | The selected Node-RED image is available and its editor opens |
| 3. Prepare components | Nodes | Packages and dependencies are available, approved and loaded by the target instance |
| 4. Configure acquisition | Templates or Node-RED editor | Addresses, points, types, scaling and byte order match the actual device |
| 5. Inspect field data | Field devices, health | Current values, quality codes and update times are correct |
| 6. Connect the cloud | Cloud | Validate actual uplink, command receipts and reconnection behavior |
| 7. Operate and maintain | Health, logs, backup, diagnostics | Investigate failures, preserve backups and the separate key, schedule changes |

**A package being available, approved and loaded are three different states.** Applying a changed approval policy restarts
the target instance. Successful acquisition does not establish command execution, recovery or cloud-page acceptance.

## Architecture and feature details

- [Technical architecture and data/control paths (Chinese)](docs/architecture/README.md)
- [Feature architecture and capability boundaries (Chinese)](docs/architecture/features.md)
- [Deployment architecture (Chinese)](docs/architecture/deployment.md)
- [Editable architecture source](docs/images/sources/thinglinks-edge.drawio)

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

## Development

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
typecheck, build, and **14 real-container passes** against a live Docker daemon —
no mocked upstreams.

```bash
cd apps/manager && pnpm verify
```

| Suite | Covers |
| --- | --- |
| `verify-authz` | Privilege-escalation attempts across roles, grant matrix, proxy and SSO |
| `verify-container-guard` | Container-creation whitelist enforced against real Docker |
| `verify-instance` | Instance creation, `settings.js` delivery, mount prefix — root and sub-path |
| `verify-proxy` | Reverse proxy, static assets, WebSocket, passwordless entry — root and sub-path |
| `verify-api` | Instance CRUD lifecycle and log decoding |
| `verify-health` | Three-layer probes |
| `verify-isolation` | Instance-to-instance network isolation |
| `verify-container` | Manager itself containerised — root and sub-path |
| `verify-compose` | Compose deployment, read-only rootfs, restricted Docker endpoint |
| `verify-cloud-gateway` | Envelope, signing, encryption, topics and reconnect against real Mosquitto |
| `verify-cloud-link` | Config → runtime → broker end to end: credential encryption, offline spooling, replay |
| `verify-cloud-tls` | TLS handshake against real certificates: CA trust, mutual auth, SNI, downgrade audit |
| `verify-setup` | First-run claim: anonymous setup, one-shot only, window expiry, no password in logs |
| `verify-2fa` | System settings and TOTP: no cookie on the password step, ticket replay, recovery codes, forced enrolment |

## Security

- Manager and instances both run **non-root** on a **read-only root filesystem**
- The Manager **never mounts the host Docker socket**; it reaches Docker only
  through a proxy that allowlists each endpoint by HTTP method
- **One network per instance** — instances cannot reach each other or the proxy
- Container creation passes a **hard whitelist**: no privileged mode, no host
  namespaces, only controlled instance data paths, editor port never directly published
- A unique private key is generated on first start; existing data without its key refuses to start instead of changing encryption identity

See the [security baseline](CONTRIBUTING.md) for the incident behind each of these rules.

## FAQ

**Can I use the Docker Hub image directly?**

It contains the complete Manager and frontend. Use the matching Compose file to wire the restricted Docker proxy, persistence and default Node-RED image together.

**Do I need Node.js, MySQL or Redis on the host?**

No separate installation is needed for container deployment. Manager uses local SQLite; Node.js and runtime dependencies are inside the image.

**Why open Node-RED through Manager?**

Manager provides a single authenticated editor entry and does not publish port 1880 directly. Configure separate application ports when a field protocol requires inbound traffic.

**Why can an offline package still fail to install?**

Check its dependency closure, approval and the policy applied to the target instance. Minimal images do not contain a full native build toolchain; binary dependencies must match the CPU architecture and runtime libraries.

**Does a Manager upgrade restart acquisition instances?**

Manager and Node-RED are independent containers. Updating Manager does not automatically restart instances. Node policy changes, instance upgrades and flow deployment each need an appropriate maintenance window.

**What is needed for migration or recovery?**

Keep the business backup and separately preserve `.master.key` or the legacy `MASTER_KEY`. Never generate a replacement key for existing data. See [backup and offline restore](docs/guides/backup-restore.md) for scope and shutdown requirements.

**Which CPU architectures are published?**

Current images cover `linux/amd64` and `linux/arm64`. Validate the particular host OS and hardware. LoongArch, RISC-V and 32-bit ARM are not currently published.

## Documentation

The Docker Hub Overview source is [docs/dockerhub-overview.md](docs/dockerhub-overview.md).
The image publishing workflow synchronizes it; `docker push` alone does not update the description.
See the [documentation index](docs/README.md) for reusable guides, image locations and maintenance conventions.

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
