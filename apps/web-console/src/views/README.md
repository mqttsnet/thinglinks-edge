# `views/` 目录划分

与后端 `core/` `http/` **同名同构**。处理云对接时三处一起动：
`core/cloud/` → `http/cloud/` → `views/cloud/`，路径对称，不用来回换算。

| 目录 | 页面 |
|---|---|
| `auth/` | `LoginView` 登录与首次改密 · `UsersView` 用户与授权矩阵 |
| `instance/` | `InstancesView` 实例列表 · `LogsView` 实时日志 |
| `edge/` | `FieldView` 现场设备台账 |
| `cloud/` | `CloudView` 云平台对接 · `broker-url.ts` 地址拆拼（纯逻辑，有单测） |
| `health/` | `HealthView` 健康监测 |
| `archive/` | `BackupView` 备份下载 |
| `flows/` | `TemplatesView` 流程模板 |
| `diag/` | `DiagView` 远程诊断 |
| `nodes/` | `NodesView` 节点管理（批准清单 / 离线包库 / 已装台账） |

文件名保留 `*View.vue` 后缀 —— 它是 Vue 生态的既有约定，devtools 里也按这个名字显示。

## 纯逻辑要抽出来，不要留在 SFC 里

`cloud/broker-url.ts` 是第一例，也是模板。抽它的理由不是 `CloudView.vue` 太长，
而是**那段逻辑的错不会报错**：把整条 broker URL 拆成四格给人改、再拼回去交给后端，
中间任何一处偏差都只表现为「地址看着对、就是连不上」，而界面上四个格子各自看都正常。

SFC 里的代码没法单测。抽成纯函数之后 15 条断言把它钉住了，
其中「往返一致」「不认识的协议退回默认」「自定义端口不被静默改掉」
这几条都是真出过问题的形态。

**判断标准**：一段逻辑如果「算错了界面也不报错」，就该抽出去测。
纯展示的模板与样式留在 SFC 里，不必为了拆而拆。
