/**
 * TCP 连通性探针（T4.5）。
 *
 * 只建连接、不发数据、立刻关掉 —— 探针不该在对端留下半个协议握手。
 * 之所以不做 ICMP ping：容器里发 ICMP 需要 CAP_NET_RAW，而我们的容器是
 * 去权限运行的；而且现场防火墙常常放行业务端口却屏蔽 ICMP，
 * ping 不通不代表端口不通，那种结论会把人带偏。
 *
 * **「连得上」同样是个有上限的结论。** 开发机上实测：跑着 fake-IP 模式的代理时，
 * 往一个根本不存在的域名的 1883 端口发起连接**会成功** —— 代理先把连接接下来，
 * 之后才发现上游不可达。透明代理、运营商劫持、企业出口设备都可能这样。
 * 所以这个探针能证否（连不上一定有问题），不能证真；
 * 「云平台到底通没通」以 cloud_link 的真实链路状态为准，不以本探针为准。
 */
import { connect as netConnect } from 'node:net';
import { DEFAULT_TIMEOUT_MS, type TcpResult } from './types.ts';

export function tcpProbe(
  host: string,
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TcpResult> {
  const started = Date.now();
  return new Promise<TcpResult>((resolve) => {
    let settled = false;
    const socket = netConnect({ host, port });
    const done = (r: Omit<TcpResult, 'host' | 'port' | 'elapsedMs'>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, port, elapsedMs: Date.now() - started, ...r });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      // remoteAddress 要在 destroy 之前读，销毁后就是 undefined 了
      const remoteAddress = socket.remoteAddress;
      done(remoteAddress ? { ok: true, remoteAddress } : { ok: true });
    });
    socket.once('timeout', () => done({ ok: false, error: `连接超时（${timeoutMs}ms）` }));
    socket.once('error', (e: Error) => done({ ok: false, error: e.message }));
  });
}
