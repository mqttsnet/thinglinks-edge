# ThingLinks Edge 控制台（前端）

Vue 3 + TypeScript + Vite + naive-ui。**不引 Vben** —— 决策与理由见下。

## 开发

```bash
# 1. 起后端（另一个终端）
cd apps/manager
EXTERNAL_URL=http://localhost:5173 \
DATA_DIR=/tmp/tle-dev \
MASTER_KEY=dev-key \
INITIAL_PASSWORD=initial-password-123 \
node dist/index.js

# 2. 起前端
pnpm dev          # http://localhost:5173
```

Vite 把 `/api` 与 `/red` 都转发给 Manager（8080），避免跨域与 Cookie 问题。

> **`EXTERNAL_URL` 必须与浏览器实际访问的地址一致。**
> Vite 8 默认监听 IPv6 `::1`，浏览器发出的 Origin 是 `http://localhost:5173`；
> 若 `EXTERNAL_URL` 写成 `http://127.0.0.1:5173`，WebSocket 会被 Origin 校验拒绝。

## 开发环境的一个已知限制

Manager 跑在宿主上时**解析不了容器名**（`tle-nr-{id}:1880`），因此：

- 健康页的「应用层 HTTP 探针」会显示 `fetch failed`
- 「打开编辑器」的反代也不通

这不是缺陷 —— 生产环境 Manager 是容器、与实例同处一个网络。
两条链路都已在真实环境验证过（`apps/manager/scripts/verify-health.mjs`、`verify-proxy.mjs`）。

## 为什么不用 Vben

原计划是 fork Vben 5 的 `web-naive` 变体，后改为直接自建。**前提变了**：

1. **后端 monorepo 已存在** —— `@vben/*` 未发布到 npm，Vben 是模板不是依赖，
   引入意味着把它整个 monorepo 搬进来，与现有根配置（turbo / pnpm-workspace / tsconfig）冲突
2. **05 文档已定 schema 驱动渲染器** —— 我们本就要建自己的 UI 抽象，
   叠在 Vben 的表单/表格抽象之上是重复分层
3. **范围收窄** —— 先做 Node-RED 切片，六到八个页面，用不上多标签页、
   三语言 i18n、主题定制器、企业级 RBAC 界面

代价是导航/布局/权限守卫自己写（约 500 行）。**设计语言仍沿用**
`flexy-vuetify-vue3-dashboard` 的 DARK_BLUE 色板与形态，与交互原型一致。

## 结构

```
src/
├── api/          与 Manager 的契约（types.ts）与客户端（client.ts，含 CSRF 双提交）
├── layout/       AppShell —— 导航、顶栏、窄屏降级为图标栏
├── views/        LoginView（含首次强制改密）· InstancesView · HealthView
├── styles/       tokens.css —— 设计令牌，深浅色都显式定义
└── router.ts     路由守卫：未登录回登录页；未改密不放行其它页
```
