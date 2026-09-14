import type { FlowNode } from '../types.ts';
import { functionNode } from './builtin/common.ts';

/** HTTP push needs an acceptance receipt. Use the same Manager ingress as tl-uplink,
 * with Node-RED's HTTP transport; neither this adapter nor its flow publishes MQTT. */
export function presenceHttpTransport(): FlowNode[] {
  return [
    functionNode('presence-uplink-request', '提交采集数据', `const base=env.get('TLE_MANAGER_URL'),token=env.get('TLE_INGEST_TOKEN');
if(!base||!token)return [null,{req:msg.req,res:msg.res,statusCode:503}];
return [{req:msg.req,res:msg.res,method:'POST',url:String(base).replace(/\\/$/,'')+'/api/edge/uplink',
headers:{'content-type':'application/json',authorization:'Bearer '+token},requestTimeout:4000,
payload:{nodeId:msg.nodeId,serviceId:msg.serviceId,data:msg.payload}},null];`, [['presence-uplink-http'],['presence-uplink-result']]),
    { id:'presence-uplink-http',type:'http request',z:'tab',name:'等待平台接收',method:'use',ret:'obj',paytoqs:'ignore',url:'',tls:'',persist:false,proxy:'',insecureHTTPParser:false,authType:'',senderr:false,headers:[],x:970,y:240,wires:[['presence-uplink-result']] },
    functionNode('presence-uplink-result','回复平台接收结果',`if(!msg.res||msg.res.headersSent||(msg.res._res&&msg.res._res.headersSent))return null;
const accepted=msg.statusCode===202&&msg.payload&&Number.isSafeInteger(msg.payload.accepted)&&msg.payload.accepted>0;
return {req:msg.req,res:msg.res,statusCode:accepted?202:503,headers:{'content-type':'application/json',...(accepted?{}:{'retry-after':'5'})},
payload:accepted?{received:true,delivery:'asynchronous'}:{received:false,error:'平台暂未接受数据，请稍后重试'}};`,[['response']]),
    { id:'presence-uplink-errors',type:'catch',z:'tab',name:'平台接收异常',scope:['presence-uplink-http'],uncaught:false,x:950,y:340,wires:[['presence-uplink-result']] },
  ];
}
