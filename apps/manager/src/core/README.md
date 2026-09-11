# `core/` 目录划分

按**领域**分目录，一个目录一件事，目录内一文件一职责。
不用 `index.ts` barrel —— 全仓库统一按路径直接引用（`../auth/crypto.ts`），
少一层间接，跳转和检索都更直接。

## 根下只放跨领域基础

| 文件 | 为什么在根 |
|---|---|
| `config.ts` | 所有领域都要读配置 |
| `db.ts` | 所有领域都要访问同一个 SQLite 与迁移 |
| `version.ts` | 版本号被 http 层与 core 多处引用，放任何子目录都成环 |

**往根下加文件前先想清楚它属于哪个领域。** 根是留给「谁都要用」的东西的，
不是给「一时想不好放哪」的东西的。

## 领域目录

| 目录 | 职责 | 未来归属（`05` 号文） |
|---|---|---|
| `auth/` | 账号会话、角色与实例授权矩阵、凭据加解密 | 内核（权限与凭据） |
| `instance/` | Node-RED 实例编排：仓储、服务、容器参数白名单、Docker 客户端、端口分配、settings.js 生成、日志解帧 | `nodered-host` 插件 + 内核 Workload |
| `health/` | 三层探针、宿主资源、指标历史 | 内核（Workload 探针） |
| `archive/` | tar 打包解包、备份与恢复 | `backup` 插件 |
| `cloud/` | 云平台连接：信封签名加解密、网关、微批、拓扑、物模型、TLS、接入配置 | `uplink` 插件 |
| `spool/` | 分段日志与断网续传 | `uplink` 插件 |
| `edge/` | 现场设备台账与南向探测 | `southbound` 插件 |
| `flows/` | 流程模板：解析、体检、内联凭据扫描、兼容性、Node-RED Admin API | `nodered-host` 插件 |
| `diag/` | 诊断包、脱敏、DNS/TCP/SNTP 探针 | `diagnostics` 插件 |

最后一列是 `05-平台架构与插件框架.md` 规划的插件划分。**现在还没有插件框架**
（C 组待做），这里只是把边界先在目录层面划出来，将来真做插件化时
搬运的是整目录而不是从一堆平铺文件里挑。

## 刻意没做的事

**没有建 `workload/` 目录。** `05` 号文里 Workload 是内核唯一的运行时抽象，
但那个抽象现在**并不存在** —— `container-spec.ts` 里是 `InstanceSpec`、
`containerName()` 拼的是 `tle-nr-<id>`，通篇都是 Node-RED 实例。
凭空建一个 `workload/` 会让人以为泛化已经做了，实际没有。
等 C1 真做泛化时再从 `instance/` 里把通用部分切出去。
