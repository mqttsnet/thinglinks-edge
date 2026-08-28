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
| `edge/` | `ingest.ts` 实例上报入口 · `field.ts` 控制台读台账 |
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
