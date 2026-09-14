# 实例网络保护边界

本模块是独立的宿主网络保护进程。它接受 Docker 策略服务通过私有 Unix socket 提交的受管网络描述，不接受 shell、iptables 参数或任意命令。Manager 和 Node-RED 不挂载该 socket 所在卷。

## 分层

| 文件 | 职责 |
| --- | --- |
| `descriptor.ts` | IPv4 网络身份、网关、bridge、保护地址及精确端点校验 |
| `rules.ts` | 生成仅作用于本来源 CIDR 与入口接口的规则，以及规范化已知的内核输出格式 |
| `firewall.ts` | 无 shell 的有界命令执行、真实接口与规则核验、归属保护及原子更新 |
| `store.ts` | 私有控制域与描述持久化，原子替换、文件和目录 fsync |
| `controller.ts` | 持久意图、注册/恢复/移除顺序、对等网络扩展及只读就绪状态 |
| `server.ts` | 私有控制接口与按真实来源地址判断的只读就绪接口 |
| `config.ts` | 部署参数与运行权限约束 |

## 接口

默认私有入口为 `/run/tle-network/control.sock`，目录权限 `0700`、socket 权限 `0600`，仅网络保护进程和 Docker 策略服务共享该卷。

- `GET /healthz`：返回 `supported`、`recovered`；后端不支持或恢复未完成时为 `503`。
- `POST /networks/register`：持久化并落实网络描述，完整核验后才返回 `{registered:true,ready:true,networkId}`。
- `GET /networks/{networkId}/ready`：核验已注册网络的实际就绪状态。
- `DELETE /networks/{networkId}`：按归属移除自己的规则，成功返回 `{removed:true,networkId}`；未知记录幂等返回成功。

默认 TCP 端口 `31555` 只提供读取：`/healthz` 限本机，`/ready?network=ID` 仅接受来自该描述实际 IPv4 CIDR 的请求。忽略 `X-Forwarded-For` 等身份头，不向此端口开放配置接口。就绪查询不安装或放宽规则；可信后台协调任务负责修复。

## 注册与恢复

描述包含 `networkId`、规范 IPv4 `cidr`、`gateway`、`bridge`、`ipv6Enabled:false`、`protectedHosts`、`peerCIDRs` 与 `allowedHostEndpoints`。端点仅允许 `{address,port,protocol}`，协议为 `tcp` 或 `udp`。Docker 策略服务须先独立核验 Docker 归属；本进程再核验真正存在的 bridge 和地址。

新网络注册时，先把其 CIDR 合并到其他有效描述，再持久化。全部必要来源的保护生效前，新网络不能就绪。删除网络后保守保留其他描述中的旧对等 CIDR，避免地址重分配时产生放行窗口。

已经消失的入口接口单独标记 `source-missing`。它自身不能就绪，但不会阻塞没有实际风险的其他网络；接口仍存在而规则不完整的来源会标记 `pending`，必要的对等保护完成前相关启动继续等待。

`owner-id` 和 `networks.json` 必须一起持久保留。已有描述但控制域丢失、损坏或不匹配时停止恢复，不自动生成新控制域接管内核规则。每条规则的注释包含完整控制域和网络 ID；同名外来链、未知规则拒绝覆盖或删除。不同控制域的精确、不匹配当前入口接口的跳转可以共存。

## 规则顺序与边界

1. 允许本来源访问自身网关的只读健康端口。
2. 允许既有入站连接的 `REPLY` 方向回复；不宽放所有 `ESTABLISHED`。
3. 放行显式配置的原目标 IPv4、端口和协议。
4. 拒绝宿主本地 IPv4、部署额外保护地址、网关与对等 CIDR。
5. 其余流量返回宿主原有规则处理。

因此这是宿主和对等实例的保护策略，不是默认禁止所有现场私网或所有互联网流量。宿主原有规则仍可能进一步拒绝某个显式端点。

仅支持已经核验的 `iptables-nft` 和有效 `DOCKER-USER` 路径。更新使用 `iptables-restore --noflush`，只重建本控制域拥有的链；首次创建用 `-N`，同名占用时失败。进程崩溃、退出或重启不会主动删除内核保护；重新启动先读取持久描述，再核验和恢复。

IPv6 描述拒绝注册；Docker 策略与固定启动约定同时关闭实例自身 IPv6，不能把 IPv4 规则宣称为 IPv6 隔离。实际本地地址会从内核补入保护，无法从 Linux VM 枚举的外层宿主地址必须由可信部署配置提供。接口、地址或部署拓扑变化后需要重新核验。
