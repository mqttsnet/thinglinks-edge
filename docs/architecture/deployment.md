# ThingLinks Edge 部署架构

[![ThingLinks Edge 部署架构](../images/architecture/edge-deployment.svg)](../images/architecture/edge-deployment.svg)

## 运行方式

| 场景 | 说明 |
| --- | --- |
| 本地独立运行 | 不启用云连接时，仍可运行现场流程并通过本地控制台管理 |
| 园区私有云 | 现场 Edge 接入园区网络内的 ThingLinks Cloud |
| 公网云边协同 | 按网络与证书配置连接公网 ThingLinks Cloud |
| 多现场接入 | 每个工厂或站点独立部署 Edge，连接统一云平台；不表示 Manager 跨主机多活 |

## 最短在线部署

在空目录中从镜像取出配套文件：

```bash
docker run --rm --pull=always --entrypoint cat mqttsnet/thinglinks-edge:1.0.1 /app/docker-compose.yml > docker-compose.yml
```

填写 Compose 顶部的访问地址与初始管理员密码，然后执行：

```bash
docker compose up -d
```

首次启动自动准备数据目录、受限代理和默认 Node-RED 镜像，并创建管理员。用 `admin` 与所填密码登录。
已有账号的升级不重置密码。详细说明见 [README 快速开始](../../README.zh-CN.md#快速开始)。

## 数据与交付边界

- `<EDGE_DATA_ROOT>/.master.key` 是独立密钥，必须安全保管；业务备份不包含它。已有数据却缺失密钥时，不应重新生成。
- Manager 与 Node-RED 实例独立运行。更新 Manager 不会自动重启采集实例；节点策略下发和实例升级另行安排维护窗口。
- 编辑器 1880 通过 Manager 进入，不直接映射宿主；现场 TCP/UDP 接入端口按实例配置开放。
- 离线包需要匹配 CPU 架构，携带镜像及节点完整依赖；不包含 Docker Engine。
- 当前发布镜像为 Linux amd64 和 arm64，具体国产 CPU、操作系统和硬件外设仍需分别验证。

[备份与恢复](../guides/backup-restore.md) · [离线安装](../../scripts/offline/README.md) · [架构总览](README.md)
