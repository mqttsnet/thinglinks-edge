/**
 * 时钟探针（T4.5）—— SNTP 对时与本机时钟状态。
 *
 * 单独成文件的理由不只是行数：**时钟是排障里一条独立的线索**。
 * 签名用 `sha256(timeStamp + ":" + signKey)`，边缘时钟偏了几分钟，
 * 云侧就会因为时间窗判定而拒收，**而表现是「连接正常但数据不进库」**，
 * 和 signKey 填错一模一样。有个客观的时钟偏差读数，这两种原因才分得开。
 *
 * 只读偏差，**绝不设置系统时钟** —— 容器没有 CAP_SYS_TIME，
 * 而且改宿主时钟是运维决定，不是诊断工具该做的事。
 */
import { createSocket } from 'node:dgram';
import { DEFAULT_TIMEOUT_MS, type ClockResult } from './types.ts';

/** NTP 纪元与 Unix 纪元之间差 70 年 */
const NTP_EPOCH_OFFSET_SEC = 2_208_988_800;

/** 超过这个偏差就认为会影响云侧验签 */
const TOLERANCE_MS = 30_000;

/** 从 NTP 时间戳字段（8 字节：32 位秒 + 32 位小数）读出毫秒 */
function readNtpTimestamp(buf: Buffer, offset: number): number {
  const seconds = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  return (seconds - NTP_EPOCH_OFFSET_SEC) * 1000 + (fraction * 1000) / 2 ** 32;
}

export interface SntpResult {
  ok: boolean;
  /** 正数表示本机比参考时间慢 */
  offsetMs?: number;
  roundtripMs?: number;
  error?: string;
}

/** SNTP 客户端（RFC 4330 的子集） */
export function sntpQuery(
  server: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  port = 123,
): Promise<SntpResult> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (r: SntpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: `SNTP 超时（${timeoutMs}ms）` }),
      timeoutMs,
    );

    // LI=0 VN=3 Mode=3(client)，其余字段留零由服务端填
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b;

    socket.once('error', (e: Error) => finish({ ok: false, error: e.message }));
    socket.once('message', (msg) => {
      const t4 = Date.now();
      if (msg.length < 48) {
        finish({ ok: false, error: `SNTP 响应长度异常：${msg.length}` });
        return;
      }
      const t1 = readNtpTimestamp(msg, 24);   // originate：服务端回抄的我们的发送时刻
      const t2 = readNtpTimestamp(msg, 32);   // receive
      const t3 = readNtpTimestamp(msg, 40);   // transmit
      finish({
        ok: true,
        offsetMs: Math.round(((t2 - t1) + (t3 - t4)) / 2),
        roundtripMs: Math.round((t4 - t1) - (t3 - t2)),
      });
    });

    // 把发送时刻写进 transmit 字段，服务端会原样抄回 originate，用它算偏差
    const t1 = Date.now();
    packet.writeUInt32BE(Math.floor(t1 / 1000) + NTP_EPOCH_OFFSET_SEC, 40);
    packet.writeUInt32BE(Math.floor(((t1 % 1000) / 1000) * 2 ** 32), 44);

    socket.send(packet, port, server, (e) => {
      if (e) finish({ ok: false, error: e.message });
    });
  });
}

/**
 * 时钟状态。
 *
 * `ntpServer` 留空表示**不发起对时查询**，与升级检查同一条原则：
 * 现场大量站点没有外网，工业客户对「设备自己往外连」也很敏感，
 * 必须由部署方显式配置才联网。留空时如实说明没检查，不编一个「正常」出来。
 */
export async function readClock(
  ntpServer = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ClockResult> {
  const base: ClockResult = {
    localTime: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    uptimeSec: Math.round(process.uptime()),
    ok: true,
    note: '未配置时钟源（NTP_SERVER），只报告本机时钟，未与外部参考比对',
  };
  const server = ntpServer.trim();
  if (server === '') return base;

  const r = await sntpQuery(server, timeoutMs);
  if (!r.ok) {
    return { ...base, server, ok: false, note: `与 ${server} 对时失败：${r.error ?? '未知原因'}` };
  }
  const offsetMs = r.offsetMs ?? 0;
  const within = Math.abs(offsetMs) < TOLERANCE_MS;
  return {
    ...base,
    server,
    ok: within,
    ...(r.offsetMs === undefined ? {} : { offsetMs: r.offsetMs }),
    ...(r.roundtripMs === undefined ? {} : { roundtripMs: r.roundtripMs }),
    note: within
      ? `与 ${server} 偏差 ${offsetMs}ms，在容差内`
      : `与 ${server} 偏差 ${offsetMs}ms —— 偏差过大可能导致云侧验签失败，`
        + '表现为「连接正常但数据不进库」，请先校准系统时钟',
  };
}
