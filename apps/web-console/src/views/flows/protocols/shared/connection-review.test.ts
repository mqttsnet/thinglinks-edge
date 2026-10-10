import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewProtocolConnection } from './connection-review.ts';
import type { Instance } from '../../../../api/types.ts';
const instance={id:'line',adminRoot:'/edge/red/line/',ports:[]} as unknown as Instance;
test('inbound TCP and UDP match protocol and container port, never guess an exposed host address',()=>{
  const target={...instance,ports:[{containerPort:15001,hostPort:30001,protocol:'tcp' as const,hostIp:'127.0.0.1',purpose:''}]};
  const tcp=reviewProtocolConnection('builtin:tcp',{mode:'server',port:15001},target);
  assert.match(tcp.details.join(''),/30001/);assert.match(tcp.warnings.join(''),/本机/);
  const udp=reviewProtocolConnection('builtin:udp',{port:15001},target);assert.match(udp.warnings.join(''),/未找到/);
  assert.ok(!tcp.details.some(x=>x.includes('192.168')));
});
test('HTTP push preserves actual base path and does not advertise management origin as public ingress',()=>{
  const result=reviewProtocolConnection('builtin:http-receive',{path:'/devices/report'},instance);
  assert.match(result.details.join(''),/POST \/edge\/red\/line\/api\/devices\/report/);
  assert.match(result.warnings.join(''),/鉴权/);
});
test('expanded IPv6 loopback mappings and wildcard interfaces have the same guidance as short forms',()=>{
  for(const hostIp of ['0:0:0:0:0:0:0:1','::1','::ffff:127.0.0.1']) {
    const target={...instance,ports:[{hostIp,hostPort:30001,containerPort:15001,protocol:'tcp' as const,purpose:''}]};
    assert.match(reviewProtocolConnection('builtin:tcp',{mode:'server',port:15001},target).warnings.join(''),/本机/);
  }
  const target={...instance,ports:[{hostIp:'0:0:0:0:0:0:0:0',hostPort:30001,containerPort:15001,protocol:'tcp' as const,purpose:''}]};
  assert.match(reviewProtocolConnection('builtin:tcp',{mode:'server',port:15001},target).details.join(''),/现场网卡/);
});
test('outbound guidance flags loopback, masks query values and preserves protocol distinctions',()=>{
  const http=reviewProtocolConnection('builtin:http-poll',{url:'http://127.0.0.1:8080/data?token=private',requestTimeout:10000});
  assert.match(http.warnings.join(''),/实例自身/);assert.ok(!JSON.stringify(http).includes('private'));
  assert.match(reviewProtocolConnection('builtin:opcua',{}).details.join(''),/NodeId/);
  assert.match(reviewProtocolConnection('builtin:s7',{}).details.join(''),/DB1,REAL0/);
});
