import type { Instance } from '../../../../api/types.ts';
export interface ConnectionReview { title: string; details: string[]; warnings: string[] }
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
function normalizedHost(host: string): string {
  try { return new URL(`http://${host.includes(':')&&!host.startsWith('[')?`[${host}]`:host}/`).hostname.replace(/^\[|\]$/g,'').toLowerCase(); }
  catch { return host.toLowerCase(); }
}
const loopback=(host:string)=>{
  const normalized=normalizedHost(host);
  return normalized==='localhost'||normalized==='::1'||/^127\./.test(normalized)||/^::ffff:7f[0-9a-f]{2}:/.test(normalized);
};
function endpoint(value:unknown): {display:string;host:string} {
  try { const url=new URL(text(value));return {display:`${url.protocol}//${url.host}${url.pathname}${url.search?'?（查询参数已省略）':''}`,host:url.hostname}; }
  catch{return {display:'请填写完整服务地址',host:''};}
}
export function reviewProtocolConnection(id: string, values: Record<string,unknown>, instance?: Instance): ConnectionReview {
  const result:ConnectionReview={title:'接入前核对',details:[],warnings:[]};
  const {details,warnings}=result;
  if(id==='builtin:udp'||id==='builtin:tcp'&&values.mode==='server') {
    const protocol=id==='builtin:udp'?'udp':'tcp';result.title='设备往哪里发送';
    details.push(`设备 → Edge 主机映射端口 → 实例 ${protocol.toUpperCase()} ${values.port ?? '待填写'} 端口。`);
    if(!instance)warnings.push('选择实例后显示其已有端口映射。');
    else {
      const mappings=instance.ports.filter(p=>p.protocol===protocol&&p.containerPort===values.port);
      if(!mappings.length)warnings.push(`未找到对应的 ${protocol.toUpperCase()} 入站端口映射；外部设备接入前请在实例管理中准备入口。同实例内的模拟发送不需要宿主映射。`);
      for(const p of mappings) {
        details.push(`已有映射：${p.hostIp||'所有接口'}:${p.hostPort} → 实例 ${p.containerPort}/${protocol}。设备使用主机端口 ${p.hostPort}。`);
        if(loopback(p.hostIp))warnings.push('此映射仅供 Edge 主机本机访问，远端现场设备不能直接连接。');
        else if(['0.0.0.0','::',''].includes(normalizedHost(p.hostIp)))details.push('设备地址填写 Edge 主机的现场网卡 IP，不填写 0.0.0.0。');
      }
    }
    details.push(protocol==='tcp'?'设备主动发送报文；按换行或固定字节数切出完整一帧。':'一个 UDP 数据报作为一帧，不等待换行符。');
    warnings.push('一份配置对应一台逻辑设备；不同设备共用入口前需要增加设备身份解析。');
  } else if(id==='builtin:http-receive') {
    result.title='设备推送接口';
    const path=text(values.path);
    if(instance&&/^\/[a-zA-Z0-9/_-]+$/.test(path)&&!path.includes('//'))details.push(`实例内请求路径：POST ${instance.adminRoot.replace(/\/?$/,'/')}api${path}`);
    else details.push('选择实例并填写推送路径后，显示完整的实例内请求路径。');
    details.push('请求 Content-Type: application/json；源字段按报文层级填写，如 data.temperature。');
    warnings.push('此路径不是已开放的设备入口。管理代理有鉴权，请先准备设备可访问的受保护入口及 TLS；不要使用编辑器端口作为设备接入地址。');
    details.push('202 表示已解析并交给流程，400 表示数据或点位不符合配置；上云结果另看现场设备和云端数据。');
  } else {
    result.title='Edge 主动连接设备';
    const remote=id==='builtin:http-poll'||id.startsWith('builtin:opcua')?endpoint(values.url??values.endpoint):{display:`${text(values.host)||'设备地址待填写'}:${values.port??''}`,host:text(values.host)};
    details.push(remote.display,'无需为主动连接新增实例入站端口映射；设备服务端需允许此实例访问。');
    if(loopback(remote.host))warnings.push('该地址指向 Node-RED 实例自身；现场设备请填写实际设备地址。');
    if(id==='builtin:tcp')details.push('连接后等待设备主动发送数据。设备若要求先发送查询帧，需在 Node-RED 补充请求节点；此模板不会猜测厂商查询指令。');
    if(id==='builtin:http-poll')details.push(`GET JSON 接口；请求超时 ${values.requestTimeout??10000} 毫秒。上次请求未结束时跳过本轮，避免请求积压。`);
    if(id.startsWith('builtin:opcua')) {
      details.push('点位填写服务器实际 NodeId（如 ns=2;s=Temperature），不是变量显示名称；数据类型需与服务器一致。');
      details.push(id==='builtin:opcua'?'兼容模板默认匿名、无安全通道。有证书或安全策略要求时，选择“OPC-UA 安全采集与控制”并核对组件支持。':'先核对安全策略、模式、应用 URI 和证书信任；证书路径指实例内文件。账号和密码在连接节点中配置。');
    }
    if(id==='builtin:s7') {
      details.push(`Rack ${values.rack??0} / Slot ${values.slot??1}；按 PLC 手册核对，不根据型号自动修改。`);
      details.push('例如 DB1,REAL0 表示 DB1 中从字节 0 开始的 REAL；填写绝对地址，并核对数据块访问方式和 PUT/GET 权限。');
    }
  }
  return result;
}
