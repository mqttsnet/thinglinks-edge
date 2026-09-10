# Node-RED 正式节点真实协议链路验收

本轮按用户要求，以已有 Node-RED 节点承担协议通信，Edge 只提供模板、映射、部署和云端联动。设备端可模拟，但必须经过真实 socket 或 Linux TTY，不用内部函数返回值替代收发。物理仪表/PLC 型号、RS485 电气与硬件时序仍另列，不把模拟端点称作实体真机。

当前进行中；只有下列带证据的项目计为通过。

## 实验边界

- 受管采集客户端复用本轮 `ui-cloud-0909`，按协议逐个替换运行；旧配置副本和加密备份保留，`line-1` 不动。
- 切换前配置/数据库备份：`before-wire-protocol-20260910.tle-backup`，schema17，46,051,364字节，SHA-256 `654d47403f4763961f9e0424cf557c2cfbfb98b7e804d3956e6d648a61e71bab`；不含 node_modules，现有安装目录原地保留。
- 正式网络设备服务器：Node-RED5.0.4，核心TCP/UDP/HTTP节点及Modbus5.60.2的正式服务器/读取节点。仅连接本轮测试网络，管理端口仅本机127.0.0.1，非root、cap-drop ALL、只读根、exec关闭。
- 协议执行复用现成 Node-RED 节点；Edge 不新增 Python 协议实现。设备服务器配置、独立原生 Snap7 资格实验及运行证据放在 `/tmp/tle-wire-20260910.9AM4ui`，独立实验不等于受管实例与真实 Cloud 验收通过。
- 自有 OPC UA 实验已从活跃的 ThingLinks Node-RED 仓库收起，停止推广和导入；优先资格验证已有 Node-RED 组件。实验归档不作为已交付能力。

## TCP：已通过页面与真实Cloud闭环

1. 内置浏览器中选择现有TCP模板，配置 `wire-protocol-server:15001`、LF分帧、子设备 `8717106890436609`、`telemetry.temperature`、倍率0.1、偏移1；从真实Cloud读取产品/版本模型。
2. 保存“标准节点线缆验收-TCP-0910”，预览并部署到已备份的临时实例。正式服务器发送raw250，正式TCP采集节点收到，Edge页面及Cloud影子均为26。
3. 在设备服务器的Node-RED页面点击“切换 raw=375” Inject；服务器raw变375且控制次数仍0，Cloud影子变38.5。
4. 从内置Cloud MQTT调试页下发41，模板逆换算为400，正式TCP控制节点经socket送到服务器；服务器实际raw400、写次数1。标准成功回执MID `8933838011789312`、errCode0，后续Cloud影子为41。
5. 真正断开实验服务器的Docker网络连接；12:52:34–12:53:45间该设备真实时序为0条。重新接回同一网络后恢复上报41（12:54:38–12:54:40），服务器写次数仍1。

证据：`/tmp/tle-wire-20260910.9AM4ui/tcp-ui-cloud-result.json`。网络已恢复，未借此修改生产网络或其他实例。

## UDP：已通过页面与真实 Cloud 闭环

1. 从页面配置并部署到 `ui-cloud-0909`，设备端使用正式 Node-RED `udp in/out`，采集端通过真实 UDP 数据报接入子设备 `8726321222676481` 的 `telemetry.temperature`。真实 Cloud 影子先为26，过程值变化后为38.5。
2. 从 Cloud 下发 `set_temperature`，参数 `value=42`。收到父网关 `/v1/devices/2130020836696065/commandResponse` 的标准 `deviceRsp`：MID `8939766010376192`、errCode0、回执参数42；后续子设备影子为42。
3. 断网窗口13:13:48–13:16:00查询真实时序为0条；恢复后的抽样记录在13:16:52、13:16:54、13:16:56均为42。恢复查询标记 `truncated:true`，这三条是抽样证据，不代表窗口总上报数。

证据：`/tmp/tle-wire-20260910.9AM4ui/udp-ui-cloud-result.json`。该记录确认值变化、标准回执和断网恢复，不据此推断未记录的设备写入次数。

## HTTP 定时采集：已通过页面与真实 Cloud 闭环

1. 从页面配置正式 HTTP 采集节点，子设备 `8730642605699073` 使用 `raw × 0.1 + 1` 映射到 `telemetry.temperature`；设备端复用 Node-RED HTTP 节点。真实 Cloud 影子从26变为38.5。
2. 从 Cloud 下发43，设备服务器观测到HTTP过程值raw420、写次数1。收到标准成功回执：MID `8942671316676608`、errCode0、参数43；后续子设备影子为43，计算与逆换算一致。
3. 断网窗口13:29:58–13:32:22查询真实时序为0条；恢复抽样在13:33:31、13:33:33、13:33:35均为43。恢复查询已截断，仅据此确认恢复后的实际样本。

证据：`/tmp/tle-wire-20260910.9AM4ui/http-poll-ui-cloud-result.json`。

## HTTP 设备推送：已通过页面与真实 Cloud 闭环

1. 从页面保存并部署“标准节点线缆验收-HTTP推送-0910”，子设备 `8736214654676993`；设备端用正式 Node-RED HTTP 节点向采集端推送。运行期纠正了目标路径：必须包含实例前缀 `/red/ui-cloud-0909/api/devices/report`。
2. 倍率0.1、偏移1：设备raw250对应Cloud26，过程值raw375对应Cloud38.5。
3. Cloud下发44，设备实际raw430，HTTP写次数从1增至2；标准回执MID `8954438042284032`、errCode0、参数44，后续Cloud值为44。写次数比较的是本条命令前后增量，包含同一设备服务器前面的HTTP定时验收基线。

证据：`/tmp/tle-wire-20260910.9AM4ui/http-push-ui-cloud-result.json`。该记录明确 `physicalHardware:false`；本节为正式节点与模拟设备端的真实网络链路，不是实体硬件验收。

## HTTPS：严格证书校验、页面与真实 Cloud 链路已验证

1. 使用现有HTTP参数副本“标准节点HTTPS证书验收-0910”，按顺序复用子设备 `8730642605699073`。实际采集客户端为Node-RED核心 `http request` 与 `tls-config`，设备端为核心 `http in/response` 加Node-RED标准HTTPS监听。
2. 在Node-RED页面配置CA文件 `/data/https-qualification-20260910/ca.pem`，保持 `verifyservercert:true`，服务器名称为 `wire-https-fixture`。raw250换算后Cloud为26，raw375换算后为38.5。
3. Cloud下发49，收到标准成功回执MID `8969687210422272`、errCode0；服务器实际raw480、写次数1，后续Cloud为49。
4. 未信任服务器证书时，Node-RED页面报告 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，15:03:50–15:04:15真实Cloud新记录为0。服务器名称不匹配时报告 `ERR_TLS_CERT_ALTNAME_INVALID`，15:12:30–15:13:00新记录为0。
5. 名称不匹配状态下下发50，标准回执MID `8970071370919936`、errCode1并报告执行结果未知；设备端写次数保持1，raw仍为480，没有执行这条指令。恢复正确配置后，15:17:37–15:17:52返回8条未截断时序记录，值全部49。

证据：`/tmp/tle-wire-20260910.9AM4ui/https-ui-cloud-result.json`。这些结果来自实际Node-RED客户端页面配置与真实Cloud，已超出独立HTTPS服务器资格测试。

配置保存边界：现有HTTP参数副本只能生成HTTPS URL，TLS配置由本轮在Node-RED UI中另外完成。2026/9/10 15:29:34已从实际实例保存并在页面核对“正式节点-HTTPS严格证书已验证-0910”，分类“网络设备”、协议 `http`，25个节点、1条流程，包含TLS节点配置。这是**完整流程快照，不是参数化TLS模板**；所引用的CA文件仍需在目标实例提供，不能把快照保存等同于证书文件已自动分发。

## Modbus-TCP：正向采集成立，断网控制负向验收失败

1. 从页面保存并部署“标准节点线缆验收-ModbusTCP-0910”，子设备 `8738959755341825`；两端分别使用正式 `node-red-contrib-modbus@5.60.2` 采集/控制节点和 `modbus-server`，服务器由正式FC3读取节点观测寄存器。
2. 倍率0.1、偏移1：raw250对应Cloud26，raw375对应Cloud38.5。正常下发45收到标准成功回执MID `8956174609969152`、errCode0。
3. 真正断开设备服务器网络后，14:18:00–14:18:40真实时序为0条。断网时下发46，MID `8956400452268032` 返回errCode1及“设备执行结果未知”。
4. 恢复网络后寄存器仍被写为raw450，Cloud变为46；结果明确 `recoveredNoDelayedWrite:false`。因此本轮不能将Modbus-TCP控制整体判为通过，也不能把已返回unknown解释成“以后不会执行”。

证据：`/tmp/tle-wire-20260910.9AM4ui/modbus-tcp-ui-cloud-result.json`。服务器没有逐次写事件计数，本记录证明恢复后观察到实际寄存器变化，不凭该记录断言重发次数。源码排查支持TCP待发字节迟到的可能路径；区分旧连接迟到与应用重新派发仍需额外证据。当前资格结果不得被队列关闭配置或此前正向成功覆盖。

## S7：已验证正向页面与 Cloud 链路、服务端正常停启

1. 从页面保存并部署“标准节点线缆验收-S7-0910”，正式 `node-red-contrib-s7@3.1.3` 连接独立官方原生Snap7服务器，子设备 `8739140626313217`。服务器使用 `/tmp` 中的 `python-snap7 2.1.0` 原生库夹具，不进入Edge产品代码。
2. raw250采集并换算后Cloud为26；过程值改为raw375后Cloud为38.5。
3. Cloud下发47，服务器 `DB1,REAL0` 实际为460，原生写事件计数1；标准回执MID `8958479665229824`、errCode0、参数47，Cloud随后为47。
4. 正常停止服务端进程时，命令MID `8959121557319680` 返回errCode1及“设备执行结果未知：Error: Not connected”；14:29:00–14:29:20时序记录为0条。
5. 重新启动服务端后过程值复位raw250、写次数0，采集恢复并使Cloud为26。本次是正常进程停止/重启，**不是网络黑洞测试**，不能借此证明黑洞恢复后无迟到写入。

证据：`/tmp/tle-wire-20260910.9AM4ui/s7-ui-cloud-result.json`。记录明确 `physicalPLC:false`，不代表实体西门子PLC及不同固件型号兼容验收。早先3.1.2纯Python服务器握手失败的独立证据仍保留。

## Modbus-RTU：正式串口采集与真实 Cloud 已通过，控制未验证

1. 从页面以标准Modbus模板为起点关闭控制，在Node-RED编辑器将正式客户端改为Serial Expert：`RTU-BUFFERD`、`9600/8N1`、串口路径 `/tmp/tle-rtu-collector`、站号1、寄存器地址0。Edge台账协议为 `modbus-rtu`，按顺序复用测试子设备 `8738959755341825`；云端设备名称仍带ModbusTCP，不代表这一轮实际走TCP。
2. 正式 `node-red-contrib-modbus@5.60.2` 通过真实Linux PTY及原生串口绑定读取RTU字节帧。raw250经计算上报Cloud26，过程值raw375上报Cloud38.5。
3. 四个故障窗口分别查询真实Cloud时序，均为0条；恢复后14:49:13–14:49:28返回7条未截断记录，值全部38.5。

| 故障 | 实际查询窗口 | Cloud新记录 |
|---|---|---|
| 错误CRC | 14:39:56–14:40:11 | 0 |
| 错站号 | 14:40:30–14:40:45 | 0 |
| 截断帧 | 14:41:02–14:41:17 | 0 |
| 串口断开 | 14:41:35–14:41:50 | 0 |

串口观测还记录了实际字节与校验结果：正常模式309个请求、309个应答均无CRC错误；错误CRC模式12个应答全部CRC无效；错站号模式3个应答CRC有效；截断模式3个应答片段CRC未通过。恢复后的末次FC3请求为 `010300000001840a`，应答为 `0103020177f9f2`，站号1、长度分别8/7字节，CRC均有效，应答寄存器值为375。原生绑定版本10.8.0，在musl环境从源代码重建，构件SHA-256为 `2c640be9ae2baf2575bc105eee21994ed1813ed0896797830213bcb2ff6c29b7`。

4. 从实例导出并保存“正式节点-RTU串口采集已验证-0910”，分类“工业采集”、协议标记 `modbus-rtu`。这是已验证配置的**流程快照**，不是新增参数化内置RTU模板。

证据：`/tmp/tle-wire-20260910.9AM4ui/rtu-ui-cloud-result.json`。记录明确 `controlVerified:false`、`physicalRS485Verified:false`、`hostSerialPassthroughProvided:false`：本轮没有验证RTU控制、物理RS485电气连接，也没有交付通用主机串口映射能力。PTY实验可用不等于现场USB/RS485设备即插即用。

## OPC UA：实际受管节点、安全通道与真实 Cloud 已验证，安装和超时边界保留

1. 受管客户端采用现成官方原包 `@tier0/opcua-client@0.6.0`，设备端运行正式 `node-opcua@2.182.2` 的 `OPCUAServer`；子设备 `8739070908592129`，模板“标准节点OPCUA安全采控-0910”。连接 `opc.tcp://tier0-opcua-fixture:4841/UA/Qualification`，安全模式 `SignAndEncrypt`、策略 `Basic256Sha256`，请求超时1000ms。
2. 安装并非一次页面操作成功：原包从UI入库，获得固定版本授权并仅向 `ui-cloud-0909` 下发。第一次页面安装因 `node-addon-api ^8.3.1` 的ETARGET失败，补入官方8.9.1后，第二次因原包没有内置 `linux-arm64-musl` 构件且环境缺少cmake失败。最终对临时实例安装精确官方原包并使用 `--ignore-scripts`，另行加入已经验证的同源ARM64原生构件，再从UI重启后运行；没有改写原始发布包。原生构件SHA-256为 `810dc2edcb04131694a7988480ede11261ff1c0bb65f0c99f1a14010603fc1f3`。
3. 服务器尚未信任客户端证书时，Node-RED页面显示 `Connect failed: BadTimeout`；同时服务器记录 `BadCertificateUntrusted`、随后 `BadSecurityChecksFailed`。客户端证书与服务器拒绝库中的证书SHA-256一致，`clientInRejected:true`、`clientInTrusted:false`；因此证书拒绝的结论由服务端日志和拒绝库共同证明，不只从页面超时猜测。15:43:00–15:43:30真实Cloud新记录为0，设备写次数0；命令MID `8978205674074112`返回errCode1、等待确认超时。
4. 将该客户端证书加入信任后，正式采集节点读取raw250、经计算使Cloud为26；过程值raw375使Cloud为38.5。Cloud下发53，服务器实际raw520、写次数1，标准成功回执MID `8980043190267904`、errCode0、参数53。
5. 将设备确认延迟设为4000ms后下发54，设备实际写raw530，总写次数变为2，但标准回执MID `8980573207687168`为errCode1、执行结果未知。到15:59:16观察已超过5分钟，写次数仍为2、没有额外重写。随后恢复延迟0，设备值530、Cloud为54。

证据：`/tmp/tle-wire-20260910.9AM4ui/opcua-ui-cloud-result.json`；匹配证书拒绝库证据：`/tmp/tle-tier0-managed-31108cf9-c168-4d5e-a9b1-95e487e42554/untrusted-client-evidence.json`。客户端与拒绝库证书SHA-256均为 `C0:A1:D0:55:15:0A:D4:F0:EC:F9:16:2A:33:B6:7C:DA:4F:29:78:1D:17:71:09:F5:BA:7B:EE:16:8A:8D:0D:31`。

结论限定：本节已经完成实际受管Node-RED页面配置、真实协议采集、计算、Cloud与命令回执验证，不再只是独立组件资格测试。**unknown不等于未执行**：54这条命令确实写入，只是没有及时拿到确认。本轮超过5分钟未重复写的观测，不代表绝对取消在途操作或所有故障情况下永不重写；记录明确 `absoluteInFlightCancellationGuaranteed:false`。原包一键安装仍未通过（`originalPackageOneClickInstallPassed:false`），同源原生构件的临时补齐不能被写成正式发行安装体验已完成。无实体设备/全型号兼容证明。

## 待串联的项目


- Modbus-TCP控制：本轮断网恢复后出现迟到写入，负向验收未通过；后续需基于可验证的组件执行语义修复并重测，不能只改队列/超时参数就宣称通过。
- HTTPS：严格CA/主机名、采集与下行的页面Cloud链路及含TLS配置的完整流程快照已验证；参数化TLS模板与证书文件自动分发尚未完成。
- HTTP推送：本轮结果文件未包含独立断网或失败响应恢复记录，不能沿用HTTP定时采集结果代替。
- Modbus-RTU：PTY采集到真实Cloud及四种故障恢复已验证，已保存流程快照；RTU控制、通用主机串口映射、实体RS485电气与硬件时序仍未验证或交付。
- S7：正向与正常停启链路已完成；真实网络黑洞、实体PLC/固件型号兼容仍未验证。
- OPC UA：受管页面Cloud链路、服务器拒绝未信任客户端和延迟确认场景已验证；原包一键安装未通过，仍依赖本轮手动补入同源ARM64构件。没有绝对取消在途写入、全部故障恢复或全型号兼容保证。

## 构建与本地部署证据

- 本轮 `pnpm check` 的lint、Manager/Web类型检查及测试完成。提供官方 `TIER0_ARCHIVE_FIXTURE` 后，官方tier0归档SRI检查实际运行；Manager共1345项，1342通过、0失败、3项既有跳过；Web69通过、0失败。
- 三项跳过仍是独立发布制品门禁：Docker builder精确生产种子、Docker runtime精确种子与工具边界、离线包manifest/SRI/SHA256SUMS覆盖。它们未因本次源码测试或镜像构建成功而被记为通过。
- `pnpm build` 成功，Manager与Web生产构建完成；本地Manager镜像构建成功，标签 `thinglinks-edge-manager:wire-20260910`，镜像摘要 `sha256:e12f84eafee8207fd9e2c62e2de9cd18e18fbbcb76c96918aa8b6aeb6a11cd58`。
- Root已更新本地Manager：容器ID `a8794073d8e50b0a0b6d75cb3c7d07c0f19d9fe87f33d4a0bd599b2215ff0d94`，运行状态healthy。部署前后核对 `line-1` 的容器ID与启动时间未变，重启计数仍为0。

证据日志：`/tmp/tle-wire-20260910.9AM4ui/pnpm-check-final.log`、`production-build.log`、`manager-image-build.log`；部署状态和 `line-1` 对照来自Root本轮运行期核验。此处分别记录源码门禁、生产构建、镜像构建与实际Manager部署，不替代协议页面、现场硬件或完整发行验收。

## 当前概览

下表只反映本轮已记录的验收结果；“通过”限定在对应链路，不代表全部设备型号或实体硬件兼容。

| 协议/方式 | 受管采集、计算与真实Cloud | 控制证据 | 本轮故障与未完成边界 |
|---|---|---|---|
| TCP | 已验证26→38.5 | 41→raw400，写次数1、成功回执及回采41 | 已验证采集断网中断和恢复；不能扩大为所有黑洞下发场景 |
| UDP | 已验证26→38.5 | 成功回执及回采42；未记录设备端写次数快照 | 已验证断网无新记录和恢复42 |
| HTTP定时 | 已验证26→38.5 | 43→raw420，写次数1、成功回执及回采43 | 已验证断网无新记录和恢复43 |
| HTTP推送 | 已验证26→38.5，实例路径已纠正 | 44→raw430，写次数增加1、成功回执及回采44 | 未独立验证本轮断网/失败响应恢复 |
| HTTPS | 实际Node-RED页面TLS配置后已验证26→38.5及恢复49，已保存完整TLS配置快照 | 49→raw480，写次数1；错名下发50未增加写次数 | 未信任CA/错名采集均0，恢复8条49；不是参数化TLS模板，CA文件仍需提供 |
| Modbus-TCP | 已验证26→38.5 | 正常下发45成功；断网命令返回unknown后仍迟到写450/Cloud46，控制验收失败 | 不能以队列关闭或正向成功覆盖负向失败 |
| Modbus-RTU | 正式串口节点、真实PTY帧、计算与Cloud已验证26→38.5；已保存流程快照 | 未验证；本轮关闭控制 | 错CRC/错站号/截断/断开均无新记录，恢复38.5；无物理串口映射交付及RS485真机证明 |
| S7 | 正式节点到原生Snap7服务器，已验证26→38.5 | 47→raw460，原生写次数1、成功回执及回采47 | 正常进程停启已验证；网络黑洞与实体PLC/固件型号未验证 |
| OPC UA | 官方原包+单独同源ARM64构件实际运行，已验证26→38.5及Cloud54 | 53→raw520/写1成功；延迟确认54实际写530但回执unknown，超过5分钟总写2无额外重写 | 未信任客户端时Cloud0/写0；原包一键安装失败；unknown不等于未执行，无绝对取消或全型号保证 |
| CoAP / BACnet / IEC104 | 本轮无受管页面与Cloud通过证据 | 未验证 | 仍为扩展候选，不能因存在第三方包而记为已接入 |

## 本轮收尾状态

- 已从 Edge 页面停止 `ui-cloud-0909`，容器 `65b9a45122130d4f062c8461410e00877b6464161dd5e7ee516b887afbe669a8` 状态为 exited，流程与数据目录保留；OPC UA 测试服务器应答延迟恢复为0。
- 停止后查询真实Cloud，OPC UA子设备 `8739070908592129` 的 `connectStatus=2`（当前Cloud代码定义为OFFLINE），最后心跳为2026-09-10 16:02:13。采集停止与云端状态已有对应证据。
- `line-1` 仍是原容器，启动时间2026-09-07T02:31:08.80056846Z，重启计数0；settings.js SHA256仍为 `4a7344719be91c19b5fdc3f4e45a326b48a7455ee7a09bb32a9daed94c84b5c5`，package.json SHA256仍为 `6b2442dfc3be5180f7d20f7f704a7c6d04a2bef4e64e9670a2c02bb13c33b7b0`。全局节点批准清单只下发到临时验收实例。
- RTU搭建中间副本已重命名为“串口验收搭建草稿-TCP待改串口-0910”，说明它仍生成TCP配置，避免与已验证的正式RTU流程快照混淆。
- `git diff --check`通过；未提交、推送或发布包。独立测试端点和资料保留，不代表现场硬件或发行验收完成。
- 新镜像的Modbus内置模板在页面尝试点击控制开关后，`aria-checked`仍为false；API与生成入口的禁止控制检查已通过对应测试。此保护只限制新模板，不改写旧快照或第三方节点本身。
