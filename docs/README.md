# ThingLinks Edge 文档

首次部署请从 [中文快速开始](../README.zh-CN.md#快速开始) 或 [English quick start](../README.md#quick-start) 进入。
本目录保留可复用的产品、部署、运维和架构说明。

## 使用与运维

| 文档 | 内容 |
| --- | --- |
| [部署说明](architecture/deployment.md) | 在线启动、不同现场的部署方式、数据与交付边界 |
| [协议组件与采集控制](guides/protocol-components.md) | 组件准备、设备点位配置、物模型映射与控制限制 |
| [备份与恢复](guides/backup-restore.md) | 密钥保管、恢复范围、停机前提与中断恢复 |
| [品牌与关于页配置](guides/product-branding.md) | 产品名称、Logo、版权、社区与更新记录配置 |
| [离线安装](../scripts/offline/README.md) | 离线交付包安装与运行要求 |

## 架构与开发

| 文档 | 内容 |
| --- | --- |
| [技术架构](architecture/README.md) | Manager、Node-RED、云端与持久化的分工 |
| [功能架构](architecture/features.md) | 功能分组和协议能力边界 |
| [协议模板扩展](../apps/manager/src/core/flows/templates/README.md) | 模板模块职责、参数校验、数据与控制链路 |
| [离线协议组件](../scripts/protocol-seed/README.md) | 固定版本、完整依赖和组件包准备 |
| [贡献指南](../CONTRIBUTING.md) | 开发约定与验证入口 |

## 目录约定

```text
docs/
├── README.md                 文档导航与维护约定
├── guides/                   使用、配置和运维说明
├── architecture/             架构与能力边界说明
├── images/
│   ├── README.md             图片清单与使用范围
│   ├── brand/                品牌图片
│   ├── screenshots/          真实产品截图
│   ├── architecture/         架构 SVG
│   └── sources/              可编辑图源
└── dockerhub-overview.md      Docker Hub 长描述源稿
```

源码旁的扩展说明和脚本使用说明保留在所属模块，通过本页导航。
任务执行计划、草稿、按日期记录的验证报告和本机环境信息放在已忽略的 `tasks/`，不提交到公共文档。
实际测试代码、验证脚本和发布变更记录继续放在各自的源码、`scripts/` 和 `changelogs/` 目录。

## 文档维护

- 中英文 README 同步维护产品能力、启动步骤与截图；首次部署只突出必填项，高级设置通过专题链接查看。
- 图片统一放在 [images/](images/README.md)，按用途选择子目录；SVG 使用原生文字与图形，配套源文件放 `sources/`。移动图片时同步修改所有语言 README 和 Docker Hub 源稿中的引用。
- 截图来自真实运行页面，标明必要的演示范围。节点入库、批准、加载和现场验收分别说明；截图中不展示密码、令牌或生产敏感配置。
- [Docker Hub 源稿](dockerhub-overview.md) 由 [镜像发布工作流](../.github/workflows/publish-image.yml) 的长描述步骤同步。单独推送镜像不会更新 Overview；图片须先公开发布，再同步使用其绝对地址的长描述。
- 提交前检查本地链接、图片和折叠区，核对版本、配置默认值和能力边界。历史测试次数、临时容器编号和本机操作日志不写入通用说明。
