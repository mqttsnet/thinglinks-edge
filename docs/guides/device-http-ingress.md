# 设备 HTTP 接入

HTTP 设备接入使用 Edge 的独立设备入口，不共用控制台登录 Cookie，也不会把设备凭据转发给 Node-RED。管理员先为一个实例和一个设备创建绑定，接口只会把请求转发到该实例的 `httpNodeRoot` 下的固定路径。

## 配置绑定

绑定管理需要已登录的 `instance:operate` 权限：

```text
POST /api/instances/{instanceId}/device-http-bindings
{
  "id": "meter-a",
  "targetPath": "/red/line-a/api/meter",
  "deviceId": "meter-a",
  "maxBodyBytes": 1048576,
  "rateLimitPerMinute": 60
}
```

响应中的 `secret` 只返回这一次。请放入设备的安全配置；列表接口不会再次返回它。轮换使用 `POST .../{bindingId}/rotate`，删除绑定使用 `DELETE .../{bindingId}`。轮换或删除阻止后续使用旧密钥的新请求，已开始的转发不会被撤回。

`targetPath` 必须位于该实例的 `adminRoot + api/` 下，使用字母、数字、`._~/-`；不得含百分号编码、`.`/`..` 目录或重复斜线。创建和每次转发均重新校验路径，并拒绝上游重定向。设备流程仍由 Node-RED 的 `http-in`、解析、映射和 `tl-uplink` 节点完成。

创建绑定前请先部署纳管 HTTP 推送模板。入口会通过 Node-RED 原生管理接口，核对唯一 POST 接收路径连接到一个且仅一个匹配 `deviceId` 的 `tl-device` 节点。签名通过后还会重新读取流程快照，对比已确认的流程版本和完整内容摘要。实例中任意流程部署或内容变化都会使旧入口返回 409；核对映射后，在设备入口页面选择“确认当前流程”即可继续使用原设备密钥，无需到现场修改设备凭据。旧版只保存 URL 的绑定升级后也需要先确认当前流程。

对应接口为 `POST /api/instances/{instanceId}/device-http-bindings/{bindingId}/revalidate`，要求实例操作权限和 CSRF 校验。它重新读取真实流程，仅在接收路径、唯一 `tl-device` 的设备标识仍与原绑定一致时更新已确认的流程版本，保留原密钥、防重放记录和限流计数。设备归属或路径不匹配时会拒绝确认；确认期间发生凭据轮换、删除或重建也会返回 409，需刷新后重新操作。需要改变设备归属时，请删除原绑定后重新创建并为设备配置新密钥。

当前只接受固定 POST 路径的纳管流程，暂不支持动态路径、跨流程 link 或子流程。设备标识也会放在转发的 `X-ThingLinks-Device-Id` 头中；自定义 function 的业务逻辑仍需自己验证，配置快照校验不能证明任意自定义代码的执行结果。

## 设备请求

请求地址为：

```text
POST /api/device-ingress/{bindingId}
```

设备必须发送未压缩的 UTF-8 JSON，请求头为 `Content-Type: application/json`；入口不接受查询参数。设备还需要发送三个签名请求头：

```text
X-ThingLinks-Timestamp: <Unix 秒>
X-ThingLinks-Nonce: <本次唯一随机值，16-128 个字母/数字/_- >
X-ThingLinks-Signature: <64 位小写或大写十六进制 HMAC-SHA256>
```

签名输入是请求方法、完整入口路径、绑定 ID、设备 ID、时间戳、nonce 和原始请求体 SHA-256 的换行拼接：

```text
METHOD\nPATH\nBINDING_ID\nDEVICE_ID\nTIMESTAMP\nNONCE\nSHA256(BODY_BYTES)
```

签名密钥只在 Edge 内存中解密使用；请求体大小、时间漂移、每绑定的请求速率和 nonce 重放均有硬限制。nonce 记录落在 Edge 数据库中，所以 Manager 重启后仍会拒绝重复请求。

入口转发时固定 JSON 内容类型和绑定生成的设备身份头，不转发 `Authorization`、Cookie、设备提供的身份头或控制台会话。Node-RED 的响应状态和有限大小的响应体会返回给设备，但响应使用纯文本类型及浏览器沙箱策略，避免流程返回的 HTML 在管理来源执行。设备仍可按 JSON 内容解析响应。

绑定默认每分钟最多 60 次请求、请求体最多 1 MiB；可配置范围分别为 1--6000 次和 1 KiB--8 MiB。入口最多接收 16 个并发请求，同一实例已有请求转发或正在执行生命周期操作时返回 409。请求体必须在 10 秒内发送完整，慢速发送超时返回 408。读取实例流程快照最多 5 秒、最多 1 MiB；之后的业务转发从连接到读取完整响应另有 5 秒期限，响应体最多 1 MiB。业务转发超时或响应过大分别返回 504/502，限流返回 429。

每次请求都会读取实例流程以确认版本；速率上限是保护阈值，不是吞吐保证。若实例流程快照超过 1 MiB，入口会拒绝转发并提示安全读取失败，需将接收流程放入合适的独立实例。

每次请求必须生成新 nonce。Manager 会在实际转发前持久记录它；已开始的转发即使超时也不能使用相同 nonce 重试。使用新 nonce 重试可能重复采样，因此这一机制不承诺业务“恰好一次”。通过 HTTPS 发布设备入口；HMAC 认证不提供数据加密。

入口只授权请求进入指定实例的固定业务路径。是否存在预期接收流程、是否完成点位解析、服务属性映射及云端 MQTT 上报，仍需用 Node-RED 调试输出和 ThingLinks Cloud 设备影子/历史分别验收。HTTP 202 不能单独证明云端接收或落库。
