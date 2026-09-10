# 产品品牌与关于页配置

品牌信息属于产品框架层，与设备、采集和云端连接配置分开。默认值集中在 `apps/manager/src/core/product/defaults.ts`，运行期环境变量由 `core/product/config.ts` 解析；Web 的 `src/product/` 只读取公开产品信息，不另存一套产品名称或仓库地址。

在部署 `.env` 中修改下列变量，重新部署 Manager 并刷新网页即可生效，无需为了改品牌重新构建前端。Compose 已逐项传入这些变量。直接运行 Manager 时，设置相同环境变量即可。

| 环境变量 | 用途 / 默认值 |
|---|---|
| `PRODUCT_NAME` | 产品名称：ThingLinks Edge |
| `PRODUCT_TAGLINE` | 简短副标题：边缘计算网关 |
| `PRODUCT_DESCRIPTION` | 关于页产品简介 |
| `PRODUCT_LOGO_URL` | Logo：`product-logo.svg`；支持相对公共资源路径或 HTTP(S) 图片地址 |
| `PRODUCT_COPYRIGHT_START_YEAR` | 版权起始年份：2019 |
| `PRODUCT_COPYRIGHT_OWNER` | 版权主体：MqttsNet |
| `PRODUCT_COMMUNITY_NAME` | 社区名称：MqttsNet 社区 |
| `PRODUCT_COMMUNITY_URL` | 社区地址：`https://mqttsnet.com`；留空隐藏 |
| `PRODUCT_GITHUB_REPOSITORY` | GitHub 仓库：`mqttsnet/thinglinks-edge`；格式为 `owner/repository`，留空隐藏项目入口并关闭远程记录 |
| `PRODUCT_DOCS_URL` | 默认 `auto`，跟随当前仓库 README；可填独立 HTTP(S) 文档地址，留空隐藏 |
| `PRODUCT_LICENSE` | 关于页许可证说明：Apache-2.0；留空隐藏 |
| `PRODUCT_RELEASES_ENABLED` | 是否提供 GitHub 更新记录：`true` / `false` |

产品名称用于登录页、侧栏、关于页和浏览器标题；Logo 同时用于登录页、侧栏、关于页及浏览器图标。版权组件在登录页和控制台页脚复用。侧栏收起或窄屏时，GitHub 和关于按钮仍保留为带说明的图标。

默认 Logo 是用户提供的 SVG，原样存放在 `apps/web-console/public/product-logo.svg`。替换为镜像内的新文件需要重新打包该静态资源；如果使用已有图片 URL，或者将自定义静态文件挂载到 Manager 的 Web 目录，则只需修改 `PRODUCT_LOGO_URL` 并重新部署 Manager。相对路径按控制台挂载前缀解析，支持子路径部署。

## 更新记录

- `GET /api/product` 匿名可读，只返回明确允许公开的产品字段；不会返回其它环境变量，也不会发起外网请求。
- 用户点击“更新记录”后才调用 `POST /api/product/releases`，要求登录、`system:view` 和 CSRF 校验。
- 服务端只读取配置仓库的 GitHub Releases API，项目主页、发布页和反馈地址由同一仓库配置派生。文档地址为 `auto` 时也跟随该仓库。
- 同时遵守系统设置中的“升级检查”开关；关闭该开关或 `PRODUCT_RELEASES_ENABLED=false` 后不会读取远程发布记录。
- 只读取公开发布信息，无需 GitHub Token。每次最多 10 条、响应最多 1 MiB、单条正文最多 64 Ki 字符；正文较长时提示前往发布详情。请求超时为 8 秒，并合并并发请求；成功缓存 10 分钟，失败缓存 30 秒。
- 远程说明使用受控 Markdown 子集展示，HTML 按文本转义，不执行远程内容。发布详情链接由仓库与版本标签生成，不直接采用远程返回的任意链接。
- 未联网、请求受限和没有已发布版本是不同状态，不会被展示为“已是最新”。镜像自带的当前版本说明仍可查看。

运行版本继续来自实际构建的 `/api/version`，与品牌字段分开。改变产品名称或版权不等于升级软件；GitHub 发布记录也不等于当前安装版本的未发布改动。

## 本轮验证

- 7 项定向测试通过：环境覆盖、公开字段隔离、链接校验、关闭可选入口、GitHub 缓存与并发、失败/空结果、大小限制，以及 HTTP 权限/CSRF/联网开关。
- Manager/Web 类型检查及改动文件 lint 通过，前端生产构建在独立临时输出目录完成。
- 独立浏览器预览检查了登录页、关于页、800px 更新记录弹窗、收起导航后的图标入口，以及使用另一组环境变量替换名称、版权、社区和 GitHub 仓库。
- 更新记录在预览中实际访问了配置仓库的 GitHub API；当时返回发布记录 `1.0.0`，当前构建版本为 `1.0.1`，二者分开展示。
- 预览只使用隔离的登录/版本数据，不连接真实实例或设备。

### 本地部署更新（2026-09-10）

随后按用户要求构建并更新本地 Manager，服务地址为 `http://127.0.0.1:19100`。镜像为 `thinglinks-edge-local:branding-20260910`，摘要 `sha256:ad870bf3c21e39aa6f3bba71ceea26c701c888492c1046a2626be358dbe90fc2`；同时更新本地 Compose 使用的 `mqttsnet/thinglinks-edge:1.0.1` 标签，没有推送镜像。

- 完整 `pnpm check` 通过：Manager 1322 通过、3 个既有跳过；Web 69 通过。Docker 构建通过。
- 新 Manager 容器 `bc9598e14d1810d21772a5786b4297322e1eab9b0a096b5cd4f5aa4d50e4c219` 健康；公开产品配置接口返回新品牌字段，正式登录页已显示指定 SVG、2019-present 版权与 MqttsNet 社区链接。
- 新版镜像选项已进入运行配置：`5.0.7-24-minimal,5.0.4-24-minimal,4.1.13-22-minimal`；5.0.7 arm64 镜像已在本机。没有升级任何 Node-RED 实例。
- `line-1` 容器 ID、启动时间、重启次数、设置与包清单摘要未变；两个临时实例保持停止。
- 更新前保留回退镜像 `thinglinks-edge-local:before-branding-20260910-033307`，并使用既有备份机制生成 `manager/backups/before-branding-20260910-033307.tle-backup`（schema 17、3 个实例、加密配置/数据库快照；不含 node_modules，实例目录原地保留）。
- 正式登录页及公开配置已实测；登录后的关于页交互与 GitHub 读取沿用前述独立预览验证，本轮未绕过登录访问受保护页面。
