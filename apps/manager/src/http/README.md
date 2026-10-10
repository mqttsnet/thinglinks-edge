# `http/` 目录划分

与 `core/` **同名同构**：处理云对接时你要动 `core/cloud/` 和 `http/cloud/`，
两条路径对称，脑子里不用来回换算。将来真做插件化（`05` 号文 C 组），
一个插件搬走的就是 `core/X/ + http/X/` 两个目录。

## 根下只放装配层

| 文件 | 职责 |
|---|---|
| `app.ts` | 服务装配 —— 谁挂在哪个插件作用域下 |
| `context.ts` | 全站共享上下文与 `guard`。**所有路由都依赖它**，放任何子目录都会成环 |
| `console.ts` | 前端静态资源托管，属于装配的一部分 |
| `version.ts` | 版本与升级检查，不属于任何业务领域 |

## 领域目录

| 目录 | 内容 |
|---|---|
| `auth/` | `session.ts` 登录登出改密 · `users.ts` 用户与授权矩阵 |
| `instance/` | `crud.ts` 实例增删改查 · `sso.ts` 免密跳转 · `proxy.ts` 反代 · `flows.ts` 流程导出套用 · `templates.ts` 模板增删查改 · `flows-target.ts` 两者共用的实例寻址 |
| `edge/` | `ingest.ts` 实例上报入口 · `device-ingress.ts` 物理设备 HTTP 入口 · `field.ts` 控制台读台账 |
| `cloud/` | `config.ts` 云对接配置与状态 |
| `diag/` | `bundle.ts` 诊断包 · `probe.ts` 单次探测 · `secrets.ts` 凭据收集 · `index.ts` 装配 |
| `archive/` | `backup.ts` 备份下载 |
| `health/` | `metrics.ts` 指标趋势 |

## 几条切分理由（不是按行数切的）

**`edge/` 按鉴权方式切开。** `/api/edge/*` 是实例用**接入令牌**往里写
（长期运行的自动化流程，没有「登录」这一说）；`/api/field/*` 是人用
**管理会话**往外读，要过角色与实例授权矩阵。混在一个文件里，改动时很容易
把某条路由挂到错误的鉴权上 —— 而那种错误不报错，只会让某个接口悄悄变成谁都能调。

**`instance/flows.ts` 与 `templates.ts` 按权限边界切开。** 模板增删改查走全局的
`template:manage`；把模板**套到某台实例上**走 `instance:operate`，要过那台实例的
授权矩阵 —— 有权管模板不等于有权动别人负责的产线。

**`diag/secrets.ts` 单独成文件**是因为它是这一层唯一碰凭据的地方。集中在一处，
将来加了新的凭据来源只有这一个文件要改，漏改的后果（诊断包里带出明文）
也只需要盯这一处。

## 关于 `diag/index.ts`

全仓库只有这一个 barrel。一个领域下有多组路由时需要一个地方把它们一起挂上，
否则 `app.ts` 要逐个 import，加一组路由得改两处。它**只做转发，不含逻辑**。
其余目录只有一两个文件，`app.ts` 直接 import 即可，不必也建 barrel。

## 设备 HTTP 入口

`POST /api/device-ingress/:bindingId` 面向现场设备，不使用 Manager 登录 Cookie、CSRF
或实例接入总令牌。管理员先在
`/api/instances/:id/device-http-bindings` 创建绑定：绑定同时固定实例、Node-RED
HTTP 路径和设备身份，响应只返回一次随机 HMAC 密钥。设备请求必须带：

* `X-ThingLinks-Timestamp`：Unix 秒；允许的时钟偏差为 5 分钟；
* `X-ThingLinks-Nonce`：16--128 个 URL 安全字符，客户端每次请求必须生成新值；
* `X-ThingLinks-Signature`：小写或大写十六进制 SHA-256 HMAC。

签名原文为以下字段用换行连接：`METHOD`、入口 URL 路径（不含查询串）、绑定 id、
绑定的设备 id、时间戳、nonce、请求体 SHA-256 十六进制摘要。请求体按收到的原始
UTF-8 字节参与摘要（JSON 的空格与字段顺序也会被签名覆盖）。管理端的
绑定密钥以主密钥加密存储，nonce 和限流窗口也落在 SQLite 中，所以 Manager 重启不会
清空重放保护。

入口只接受未压缩的 UTF-8 `application/json`，不接受查询参数。Manager 固定转发 JSON
内容类型及绑定生成的设备和实例标识，绝不转发 `Authorization`、Cookie 或其它请求头。
目标路径在创建与转发时均校验为实例业务路径，拒绝百分号编码、点目录和重定向。响应
保持上游状态与有界内容，但使用 `text/plain`、`nosniff` 和沙箱 CSP，避免流程返回的
HTML 获得 Manager 来源权限。

接收请求体有 10 秒绝对截止时间，持续慢速发送也不能无限占用接入名额。读取实例流程
快照最多 5 秒、上限 1 MiB；业务转发到响应读取完整结束另有 5 秒超时，响应体上限 1 MiB。绑定请求体上限可配置
1 KiB--8 MiB，速率为每分钟 1--6000 次。整个入口最多接收 16 个并发请求；转发期间
持有实例操作锁，同一实例已有转发或生命周期操作时返回 409。已开始转发的请求即使
超时也不返还 nonce；使用新 nonce 重试可能重复采样，不能据此宣称业务“恰好一次”。

创建绑定和每次转发均通过认证读取 Node-RED 原生 v2 流程快照，确认固定 POST 路径
连接唯一且设备标识匹配的 `tl-device`，并比对存档的流程 revision 与完整内容摘要。
任意流程部署或内容变化都会让旧入口返回 409；核对映射后可通过页面“确认当前流程”
或 `POST /api/instances/:id/device-http-bindings/:bindingId/revalidate` 重新确认。
该操作在实例操作锁内重新校验路径与设备归属，仅更新 `flow_revision`，保留设备密钥、
nonce 与限流计数；更新和审计同事务，并以绑定的原密钥与版本做 CAS，拒绝并发轮换、
删除和重建。确认不匹配时不能绕过校验；也可以明确删除后重建绑定并更换设备凭据。
当前只接受固定路径的纳管 HTTP 流程，暂不支持动态路径、跨流程 link 或子流程。

这些检查证明配置中的设备归属，并不能证明任意自定义 function 的业务代码正确；
流程运行和云端 MQTT 上报、落库仍需分别验收。轮换或删除阻止后续使用旧密钥的
新请求，已开始的转发不会被撤回。

实现分层位于 `edge/device-ingress/`：`protocol.ts` 校验和签名，`store.ts` 持久重放与
限流，`flow.ts` 原生流程快照验证，`forward.ts` 有界转发，`types.ts` 共享内部类型；
外层 `device-ingress.ts` 只装配管理路由、原始请求解析和请求生命周期。
