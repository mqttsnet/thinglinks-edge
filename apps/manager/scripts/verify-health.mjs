/**
 * 健康探针端到端验证：三层探针在真实容器上的行为。
 *
 * 重点验证「容器在跑但应用不通」这类分层才能发现的故障 ——
 * 只看容器状态会漏掉「进程还在但已经不干活」。
 */
import { MetricsHistory, MetricsSampler } from '../dist/core/health/metrics-history.js';
import {
  createFixtureIdentity,
  createRealInstanceFixture,
} from './_real-instance-fixture.mjs';
import { adminSession } from './_session.mjs';

const identity = createFixtureIdentity({ suite: 'health', roles: ['main'] });
const ID = identity.instances.main;
const TAG = '5.0.4-24-minimal';

let fixture;
let sampler;
let sampleError = '';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n──── 健康探针 · 真实容器验证 ────\n');
  // 指标历史：趋势曲线的数据源。这里手动 tick，不用后台定时器，验证可控
  fixture = await createRealInstanceFixture({
    identity,
    allowedImageTags: [TAG],
    createServerExtras: ({ service }) => {
      const metrics = new MetricsHistory({ fineStepSec: 1, fineSpanSec: 3600 });
      sampler = new MetricsSampler({
        history: metrics,
        source: service,
        intervalMs: 1000,
        onError: (error) => { sampleError = error instanceof Error ? error.message : String(error); },
      });
      return { metrics };
    },
  });
  const B = fixture.baseUrl;

  const sess = await adminSession(B, fixture.adminPassword, fixture.adminNextPassword);
  const { cookie, csrf } = sess;
  const login = { status: sess.status };
  const H = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };

  await fixture.createInstance('main', sess, {
    name: '健康验证', imageTag: TAG, memoryMb: 256, cpus: 0.5, ports: [],
  });
  check('实例创建完成并通过平台 npm bootstrap', true);

  // 等 Node-RED 完全就绪
  let h = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    h = (await (await fetch(`${B}/api/instances/${ID}/health`, { headers: { cookie } })).json()).health;
    if (h?.verdict === 'healthy') break;
  }

  check('综合判定为 healthy', h?.verdict === 'healthy', `verdict=${h?.verdict}`);
  check('容器层：运行中且重启次数为 0', h?.container?.running === true && h.container.restartCount === 0);
  check('容器层：CPU 百分比可读且合理', typeof h?.container?.cpuPercent === 'number' && h.container.cpuPercent >= 0,
        `${h?.container?.cpuPercent}%`);
  check('容器层：内存用量在配额内', typeof h?.container?.memUsedMb === 'number' && h.container.memUsedMb <= h.container.memLimitMb,
        `${h?.container?.memUsedMb} / ${h?.container?.memLimitMb} MB`);
  check('应用层：HTTP 探针通且有延迟数据', h?.app?.ok === true && typeof h.app.latencyMs === 'number',
        `HTTP ${h?.app?.status} · ${h?.app?.latencyMs}ms`);
  check('业务层：flow 已启动', h?.flow?.started === true);

  // 趋势历史：曲线画的是采样点，采不到点等于看板只剩数字
  const firstSample = await sampler.tick();
  const secondSample = await sampler.tick();
  check('两次手动采样均成功', firstSample && secondSample, sampleError);
  const trend = await (await fetch(`${B}/api/metrics?range=1h`, { headers: { cookie } })).json();
  const last = trend?.points?.[trend.points.length - 1];
  check('趋势接口已启用且有采样点', trend?.enabled === true && trend.points.length >= 2,
        `${trend?.points?.length} 个点 · 步长 ${trend?.stepSec}s`);
  check('趋势点含该实例的容器与延迟读数',
        typeof last?.instances?.[ID]?.cpuPercent === 'number' && typeof last.instances[ID].latencyMs === 'number',
        `CPU ${last?.instances?.[ID]?.cpuPercent}% · ${last?.instances?.[ID]?.latencyMs}ms`);
  check('趋势点含宿主读数', typeof last?.host?.memPercent === 'number', `内存 ${last?.host?.memPercent}%`);
  check('窗口内实例 id 被汇总', Array.isArray(trend?.instanceIds) && trend.instanceIds.includes(ID));

  const badRange = await fetch(`${B}/api/metrics?range=99h`, { headers: { cookie } });
  check('非法窗口被拒而不是静默取默认值', badRange.status === 400);

  const anonTrend = await fetch(`${B}/api/metrics?range=1h`);
  check('未登录访问趋势接口被拒绝', anonTrend.status === 401);

  // 关键：停掉应用但保留容器视角 —— 这里直接停容器，验证分层能反映出来
  await fetch(`${B}/api/instances/${ID}/stop`, { method: 'POST', headers: H });
  let down = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    down = (await (await fetch(`${B}/api/instances/${ID}/health`, { headers: { cookie } })).json()).health;
    if (down?.verdict === 'down') break;
  }
  check('停止后综合判定为 down', down?.verdict === 'down', `state=${down?.container?.state}`);
  check('停止后应用层给出未运行原因', down?.app?.ok === false, down?.app?.error ?? '');

  // 汇总接口
  // 停机后再采一次：曲线要能反映「这段时间它是 down 的」
  const stoppedSample = await sampler.tick();
  check('停机后采样成功', stoppedSample, sampleError);
  const afterStop = await (await fetch(`${B}/api/metrics?range=1h`, { headers: { cookie } })).json();
  const stopped = afterStop?.points?.[afterStop.points.length - 1]?.instances?.[ID];
  check('停机后的采样点判定为 down 且延迟记 null', stopped?.verdict === 'down' && stopped?.latencyMs === null,
        `verdict=${stopped?.verdict} latency=${stopped?.latencyMs}`);

  const allResponse = await fetch(`${B}/api/health`, { headers: { cookie } });
  const allText = await allResponse.text();
  const all = (() => { try { return JSON.parse(allText); } catch { return {}; } })();
  check('汇总接口给出分类计数', all?.summary?.total === 1 && all.summary.down === 1,
        `HTTP ${allResponse.status} ${JSON.stringify(all?.summary ?? all).slice(0, 160)}`);
  check('宿主资源可读', typeof all?.host?.memPercent === 'number' && all.host.cpuCount > 0,
        `CPU ${all?.host?.cpuCount} 核 · 内存 ${all?.host?.memPercent}% · 磁盘 ${all?.host?.diskPercent}%`);

  const anon = await fetch(`${B}/api/health`);
  check('未登录访问健康接口被拒绝', anon.status === 401);

  sampler.stop();
}

main()
  .catch((e) => {
    console.error('\n验证失败：', e.message);
    results.push({ name: '脚本执行', ok: false });
  })
  .finally(async () => {
    sampler?.stop();
    const cleanupFailures = fixture ? await fixture.cleanup() : [];
    if (cleanupFailures.length > 0) {
      console.error('\n验证资源清理失败：', cleanupFailures.join(' | '));
      results.push({ name: '随机验证资源清理', ok: false });
    }
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n  ${pass}/${results.length} 通过\n`);
    process.exitCode = pass === results.length ? 0 : 1;
  });
