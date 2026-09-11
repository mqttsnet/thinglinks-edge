# 文档图片

图片按用途分类，README 和专题文档使用相对路径引用。Docker Hub 使用公开绝对地址，需在图片发布后再同步。
应用自身的运行资源继续保留在应用目录，本目录仅存放文档配图。

## 品牌与架构

| 文件 | 用途 |
| --- | --- |
| [brand/logo.png](brand/logo.png) | README 与 Docker Hub 品牌标识 |
| [architecture/edge-product.svg](architecture/edge-product.svg) | 产品总览 |
| [architecture/edge-functions.svg](architecture/edge-functions.svg) | 功能分组 |
| [architecture/edge-technical.svg](architecture/edge-technical.svg) | 技术与数据、命令链路 |
| [architecture/edge-deployment.svg](architecture/edge-deployment.svg) | 单机组件与多现场部署方式 |
| [sources/thinglinks-edge.drawio](sources/thinglinks-edge.drawio) | 四张架构图的可编辑源文件 |

## 产品截图

| 文件 | 展示范围 |
| --- | --- |
| [screenshots/edge-instances.jpg](screenshots/edge-instances.jpg) | 实例状态、版本、资源额度、编辑器与日志入口 |
| [screenshots/edge-templates.jpg](screenshots/edge-templates.jpg) | 工业协议采集模板与组件依赖 |
| [screenshots/edge-health.jpg](screenshots/edge-health.jpg) | 宿主资源趋势及容器、应用、业务三层状态 |
| [screenshots/edge-nodes.jpg](screenshots/edge-nodes.jpg) | 节点批准清单与版本信息 |
| [screenshots/edge-line1-editor.jpg](screenshots/edge-line1-editor.jpg) | 一号产线的空画布、ThingLinks 节点面板与节点帮助 |
| [screenshots/edge-modbus-device-config.jpg](screenshots/edge-modbus-device-config.jpg) | 演示配置的连接、站号、寄存器与采集周期 |
| [screenshots/edge-modbus-points.jpg](screenshots/edge-modbus-points.jpg) | 点位偏移、属性编码、类型、字节序、倍率与偏移 |

截图保留浏览器输出的原始 JPEG 格式，来自本地演示环境。空画布展示编排入口；Modbus 页面展示已有配置，均不代表现场设备或云端链路已完成验收。
重拍时更新受影响的页面并检查敏感信息。相同功能只保留一张必要视图，不为截图修改业务状态或部署流程。

[文档目录与维护约定](../README.md) · [架构说明](../architecture/README.md)
