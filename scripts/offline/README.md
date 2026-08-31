# ThingLinks Edge 离线安装包

给**没有外网**的现场用。包里已经带齐运行所需的全部镜像，安装过程不联网。

## 装

```bash
tar xzf thinglinks-edge-offline-<版本>-linux-<架构>.tar.gz
cd thinglinks-edge-offline-<版本>-linux-<架构>
./install.sh
```

脚本会依次做四件事：校验包完整性与架构 → `docker load` 导入镜像 →
生成 `.env`（含现场随机 `MASTER_KEY`）并问一次外部访问地址 → 起服务并等健康检查通过。

装完打开脚本最后打印的地址，**首次访问会让你设置管理员账号与口令**。

## 前置条件

包里**不含 docker 本体**（各发行版装法不同，且多数工控机已经装好）。现场需要：

| 项 | 要求 |
|---|---|
| Docker Engine | 20.10 以上，且 `docker compose` v2 插件可用 |
| 架构 | 必须与包名里的架构一致（`linux-amd64` / `linux-arm64`） |
| 磁盘 | 镜像约 1GB，加上实例数据建议预留 10GB 以上 |

**架构装错的表现极具迷惑性**：`docker load` 会成功，容器起来就退出，
日志里是 `exec format error` —— 和「装错包」这件事看不出关系。所以 `install.sh` 会先拦一道。

## 包里有什么

```
images.tar                  Manager、受限 docker 代理、init 容器、Node-RED 实例镜像
docker-compose.yml          主部署文件（与在线安装完全一致）
docker-compose.offline.yml  离线覆盖层：pull_policy: never
.env.example                配置模板
install.sh                  安装脚本
manifest.json               版本、架构、各镜像 ID —— 现场核对与售后追溯用
SHA256SUMS                  校验和
changelogs/                 变更说明
```

`manifest.json` 里列了随包的 Node-RED 版本，创建实例时只能选这几个 ——
白名单之外的版本在离线现场没有镜像，创建会被当场拒绝并说明原因。

## 第三方 Node-RED 节点

离线现场也装得上 —— Manager 自带一个私有 npm 源，实例的节点安装走它，
不需要连 npmjs.org。包里另外还带着 `@thinglinks` 自有节点
（设备注册、点位上报、上行出口），它们随镜像发布、不走 npm。

节点要经过**两道闸**才装得上，两道都要过：

1. **包在不在源里** —— 控制台 →「节点管理」→「离线包库」。
   随包发的节点在装完时已经自动进库了。
2. **批没批准** —— 控制台 →「节点管理」→「批准清单」。
   进了库只是「有得装」；批准是管理员的动作，批准之后还要点「下发到实例」
   （会重启实例，请挑可以停的时间点）。

**现场临时加一个节点包**（例如客户新买了一台西门子 PLC）：

```bash
# 1. 在一台有外网的机器上取包，连依赖一起
./scripts/pack-nodes.sh --out /tmp/seed node-red-contrib-s7

# 2. 把 /tmp/seed 里的 .tgz 拷到现场（U 盘即可），二选一：
#    · 控制台「节点管理 → 离线包库 → 选择文件」，可一次多选
#    · 直接拷进 <EDGE_DATA_ROOT>/manager/npm-seed/ 后重启 manager

# 3. 控制台里批准它，再「下发到实例」
```

**一定要用 `pack-nodes.sh` 而不是手工 `npm pack`**：它会把节点包
**连同整个依赖闭包**一起取下来。只拷节点包本身的话，现场点安装时
npm 会去公网找它的依赖 —— 表现是「包明明在源里，还是装不上」。
界面上也会直接把缺的依赖名字列出来。

## 升级

拿到新版本的离线包，在同一目录下重跑 `install.sh` 即可：
镜像换新、`.env` 与数据目录原样保留。升级前建议先做一次备份
（控制台 → 备份），异机恢复演练过的那条路径。

## 出问题时

```bash
docker compose ps                 # 谁没起来
docker compose logs manager       # Manager 的日志
docker compose exec manager node dist/index.js preflight    # 环境自检九项
```

自检报告可以直接贴给支持人员 —— 它把 docker 版本、架构、端口占用、网段冲突、
磁盘、时钟、外部地址可达性、证书、出网代理都查了一遍。
