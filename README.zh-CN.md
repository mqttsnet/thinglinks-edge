<div align="center">

<a href="https://mqttsnet.com"><img src="./docs/images/logo.png" alt="ThingLinks" width="180"></a>

# ThingLinks Edge

**边缘计算网关 —— 现场一台机器，一条 `docker compose up`**

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

[![Node.js](https://img.shields.io/badge/Node.js-24_LTS-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Docker Image](https://img.shields.io/docker/v/mqttsnet/thinglinks-edge?sort=semver&style=flat-square&logo=docker&logoColor=white&label=image&color=2496ED)](https://hub.docker.com/r/mqttsnet/thinglinks-edge)
[![Docker Pulls](https://img.shields.io/docker/pulls/mqttsnet/thinglinks-edge?style=flat-square&logo=docker&logoColor=white&color=2496ED)](https://hub.docker.com/r/mqttsnet/thinglinks-edge)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square)](LICENSE)

<br>

[![官网](https://img.shields.io/badge/官网-mqttsnet.com-blue?style=for-the-badge)](https://mqttsnet.com)
[![GitHub](https://img.shields.io/badge/GitHub-mqttsnet/thinglinks--edge-181717?style=for-the-badge&logo=github)](https://github.com/mqttsnet/thinglinks-edge)

</div>

---

## 项目简介

ThingLinks Edge 是装在客户现场单机上的**边缘计算网关平台**。它要做的是**云边协同**：
把现场设备接进 ThingLinks 云，把云的能力送到现场 —— 使得在与云的链路断开时，
采集、缓存与本地逻辑仍然照常工作。

Node-RED 多实例托管是**其中一个能力**，不是产品全部，只是当前优先做透的这条切片。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| **实例托管** | Node-RED 实例以兄弟容器运行 —— 升级管理台不会中断现场采集 |
| **内置反代** | 单一入口、单张证书；实例端口不映射宿主，鉴权因此天然统一 |
| **免密跳转** | 从控制台直接打开任意实例编辑器，无需再输实例口令 |
| **三层健康探针** | 容器 / 应用 / 业务三层，综合判定能识别「进程还在但已经不干活」 |
| **网络隔离** | 一实例一网络 —— 实例之间互不可达 |
| **受限 Docker 端点** | Manager 不接触宿主 socket；每次调用都要过按方法逐条的正则白名单 |
| **运行期挂载前缀** | 同一个镜像既可挂根路径，也可挂企业反代的任意子路径，无需重新构建 |
| **云边协同** | 虚拟网关、子设备注册、微批聚合、断网缓存与续传 *(进行中)* |

## 技术栈

![Node.js](https://img.shields.io/badge/Node.js-24_LTS-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?style=flat-square&logo=sqlite&logoColor=white)
![Vue 3](https://img.shields.io/badge/Vue.js-3.5-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Naive UI](https://img.shields.io/badge/Naive%20UI-2.45-63E2B7?style=flat-square)
![Vite](https://img.shields.io/badge/Vite-8.x-646CFF?style=flat-square&logo=vite&logoColor=white)
![Node-RED](https://img.shields.io/badge/Node--RED-5.0-8F0000?style=flat-square&logo=nodered&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.x-F69220?style=flat-square&logo=pnpm&logoColor=white)

## 快速开始

### 环境要求

| 组件 | 版本 |
| --- | --- |
| Docker Engine | 24+，含 Compose v2 |
| 宿主架构 | `x86_64` 或 `aarch64` —— **不支持** 32 位 ARM |
| Node.js | 24 LTS（仅开发需要） |
| pnpm | 10.32+（仅开发需要） |

> **32 位 ARM 未发布。** 决定性原因在下游：Node-RED 官方镜像 5.x 全系只有
> `amd64` / `arm64`，所以 `armv7` 上的 Manager 即使能跑，实例也会被永久锁在
> Node-RED 4.1.x。构建侧还要额外付出代价（`better-sqlite3` 无 32 位 ARM 预编译产物）。
> 更重要的是**并不适配**：真正只能跑 32 位的那批芯片（i.MX6、AM335x、A20）
> 典型只有 256MB–1GB 内存，而 Manager 实测常驻 53 MiB、每个实例约 104 MiB。
>
> **树莓派用户基本不受影响**：Pi 3 / 3B+ / Zero 2 W 的芯片本身都是 64 位的，
> 只有装 32 位系统才会落进 `armv7`。`uname -m` 显示 `aarch64` 可用，`armv7l` 则不行。

### 部署

Manager 镜像已发布在 Docker Hub：[`mqttsnet/thinglinks-edge`](https://hub.docker.com/r/mqttsnet/thinglinks-edge)，
是覆盖 `linux/amd64` 与 `linux/arm64` 的多架构清单 —— x86 工控机和 ARM 边缘盒子敲同一条命令，
docker 自己挑对应那一份。现场机器**不编译任何东西**，装了 docker 就够。

1. 下载本版本的 [docker-compose.yml](docker-compose.yml)，放进一个独立目录。
2. 填写文件顶部两项：实际访问地址（例如 `http://192.168.10.20:19100`）和自选初始管理员密码（至少 12 位）。密码填写在 `x-initial-password` 的引号中；包含 `$` 时写成 `$$`。
3. 在该目录运行：

```bash
docker compose up -d
```

打开配置的地址，用 **admin** 和刚才填写的密码登录，再创建 Node-RED 实例即可。新部署未填密码或密码过短时不会开放控制台；已有管理员的升级不要求重新填写，也不会重置账号。
**无需克隆源码、安装 Node.js、创建 `.env`、手动生成密钥、查询 Docker 组 ID 或提前拉取默认 Node-RED 镜像。**
Compose 自动拉取 Manager、受限 Docker 代理、初始化镜像和默认 Node-RED 5.0.7 镜像，并准备数据目录。

默认数据根为 `/data01/mqttsnet/thinglinks-edge`，必须专用于 Edge。首次启动会生成
`<数据根>/.master.key`（权限 0600），后续重启或升级始终复用。**密钥文件要单独安全保管，业务备份不包含它。**
已有数据却丢失密钥时系统拒绝启动，不会生成新密钥掩盖问题。

服务器默认发布 19100 端口，配置文件中含初始密码，请妥善保管。已有反向代理、rootless Docker、
自定义数据目录或离线要求时，使用 [.env.example](.env.example) 中的高级配置；
**已有 `.env` 和 `MASTER_KEY` 保持原样，新版本会沿用原加密身份。**
其它 Node-RED 版本需准备对应镜像后再选择，默认 5.0.7 由 Compose 自动准备。

`EXTERNAL_URL` 仍是对外链接和 Cookie 策略的唯一来源，不从请求头猜测。
升级时明确修改 `MANAGER_IMAGE` 的版本，再执行 `docker compose pull && docker compose up -d`。
Node-RED 实例独立运行，更新 Manager 不会自动重启采集实例。

### 本地开发

```bash
pnpm install

# 终端 1 —— 后端
cd apps/manager && pnpm build && \
  EXTERNAL_URL=http://localhost:5173 DATA_DIR=/tmp/tle-dev \
  MASTER_KEY=dev-key INITIAL_PASSWORD=initial-password-123 node dist/index.js

# 终端 2 —— 控制台
cd apps/web-console && pnpm dev      # http://localhost:5173
```

要用**自己编的镜像**而不是发布镜像跑整套栈，叠加构建覆盖文件：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

`docker-compose.yml` 本身是刻意做成「纯拉取」的 —— 那是现场机器用的形态。


## 目录结构

```
thinglinks-edge/
├── apps/
│   ├── manager/                  控制面服务
│   │   ├── src/
│   │   │   ├── core/             领域层：配置、加密、存储、鉴权、实例、
│   │   │   │                     端口、健康、容器规格、docker 客户端
│   │   │   ├── http/             HTTP 层：装配、会话、实例、免密跳转、
│   │   │   │                     反代、控制台托管
│   │   │   └── index.ts          入口
│   │   ├── scripts/              真容器验证套件
│   │   └── Dockerfile
│   └── web-console/              控制台前端（Vue 3 + TypeScript + Naive UI）
├── changelogs/                   每个版本一个文件
├── docker-compose.yml            单机部署
└── .env.example
```

## 验证

任何改动都必须让全量回归保持全绿。`pnpm verify` 会跑单元测试、类型检查、构建，
以及对真实 Docker 守护进程的 **11 次真容器验证** —— 不用模拟上游。

```bash
cd apps/manager && pnpm verify
```

| 套件 | 覆盖 |
| --- | --- |
| `verify-container-guard` | 容器创建参数硬白名单在真实 Docker 上生效 |
| `verify-instance` | 实例创建、`settings.js` 落盘、挂载前缀 —— 根路径与子路径 |
| `verify-proxy` | 反代、静态资源、WebSocket、免密跳转 —— 根路径与子路径 |
| `verify-api` | 实例 CRUD 全生命周期与日志解帧 |
| `verify-health` | 三层探针 |
| `verify-isolation` | 实例间网络隔离 |
| `verify-container` | Manager 自身容器化 —— 根路径与子路径 |
| `verify-compose` | Compose 部署、只读根文件系统、受限 Docker 端点 |

## 安全

- Manager 与实例均以**非 root**、**只读根文件系统**运行
- Manager **不挂载宿主 Docker socket**，只能通过按 HTTP 方法逐条白名单的代理访问 Docker
- **一实例一网络** —— 实例之间、实例与代理之间都不可达
- 容器创建走**硬白名单**：禁特权、禁宿主命名空间、只允许平台具名卷，实例端口绝不映射宿主
- 首次生成独立随机密钥；已有数据缺密钥时拒绝启动，不静默更换加密身份

每条规则背后都对应一次真实事故，见[贡献指南](CONTRIBUTING.md)的开发纪律。

## 文档

备份范围、离线恢复和中断恢复步骤见 [备份与离线恢复](docs/backup-restore.md)。

部署指南、接口说明与架构文档见 [mqttsnet.com](https://mqttsnet.com)。

第一次接手这个代码库？先读[贡献指南](CONTRIBUTING.md) —— 那里的开发纪律
沉淀了全部已经踩过的非显然行为。

## 参与贡献

见 [贡献指南](CONTRIBUTING.md)。那里的开发纪律不是风格偏好 —— 每一条都对应一次真实的静默故障。

## 联系我们

- 商务合作：[mqttsnet@163.com](mailto:mqttsnet@163.com)
- 问题反馈：[GitHub Issues](https://github.com/mqttsnet/thinglinks-edge/issues)
- 代码贡献：[GitHub PRs](https://github.com/mqttsnet/thinglinks-edge/pulls)

> **注意：** 本项目镜像到多个代码托管平台。Bug 反馈、功能建议与技术讨论的**唯一官方渠道**是
> [GitHub Issues](https://github.com/mqttsnet/thinglinks-edge/issues)。

## 致谢

- [Node-RED](https://nodered.org) —— 面向物联网的流式编程环境
- [Fastify](https://fastify.dev) —— 高性能低开销的 Web 框架

## 许可协议

ThingLinks Edge 基于 [Apache License 2.0](LICENSE) 开源。

---

<div align="center">

Copyright &copy; 2019-present [MqttsNet](https://mqttsnet.com). All rights reserved.

</div>
