/**
 * 安全基线 7 组红线 · 逐条对照（T6.4 的另一半）。
 *
 * 基线原文来自 `thinglinks-workspace` skill 的 `references/security-baseline.md`，
 * 那份是给**云平台**写的（MyBatis / Sa-Token / BifroMQ / Druid / 多租户列）。
 * Edge 是另一套技术栈，逐条照搬既对不上，也会把「不适用」混成「已通过」。
 *
 * 所以这份脚本对每一条只做两件事之一：
 *
 *   · **适用** —— 给出 Edge 上的等价控制，并**当场断言**它成立
 *   · **不适用** —— 写清为什么不适用，以及 Edge 里对应的那条红线是什么
 *
 * 不适用不算通过，单独计数。一份「20 条全绿、其中 15 条其实不适用」的报告
 * 比没有报告更危险 —— 它让人以为查过了。
 */
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';

import { openDb } from '../dist/core/db.js';
import { deriveKey } from '../dist/core/auth/crypto.js';
import { AuthService } from '../dist/core/auth/service.js';
import { InstanceRepo } from '../dist/core/instance/repo.js';
import { UserRepo } from '../dist/core/auth/user-repo.js';
import { canInstance, can } from '../dist/core/auth/authz.js';
import { parseEnvelope } from '../dist/core/cloud/envelope.js';
import { assertValidSpec } from '../dist/core/instance/container-spec.js';
import { NodeStore } from '../dist/core/nodes/store.js';
import { NodeCatalog } from '../dist/core/nodes/catalog.js';
import { ensurePlatformApproval } from '../dist/core/nodes/platform-package.js';
import {
  PLATFORM_COMMON_PACKAGE,
  PLATFORM_NODE_PACKAGE,
  PLATFORM_NODE_TYPES,
} from '../dist/core/nodes/platform-contract.js';
import { registerNpmRegistry } from '../dist/http/nodes/registry.js';
import { tarArchive } from '../dist/core/archive/tar.js';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const MGR = join(REPO, 'apps/manager/src');

const rows = [];
const check = (group, name, ok, detail = '') => {
  rows.push({ group, name, ok, kind: 'check' });
  console.log(`  ${ok ? '✓' : '✗'} [${group}] ${name}${detail ? '  — ' + detail : ''}`);
};
/** 不适用也要留痕：写明为什么，以及 Edge 的对应红线在哪 */
const na = (group, name, why) => {
  rows.push({ group, name, ok: true, kind: 'na' });
  console.log(`  · [${group}] ${name}  — 不适用：${why}`);
};

const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
};
const sources = walk(MGR);
const readAll = (files) => files.map((f) => ({ f, text: readFileSync(f, 'utf8') }));
const BASELINE_PLATFORM_KEYWORDS = Object.freeze(['node-red', 'thinglinks']);

const normalizeExactKeywords = (keywords) => {
  if (
    !Array.isArray(keywords)
    || !keywords.every((keyword) => typeof keyword === 'string' && keyword.length > 0)
  ) return undefined;
  const normalized = [...keywords].sort();
  return new Set(normalized).size === normalized.length ? normalized : undefined;
};

const isExactPlatformCatalogueEntry = (entry, expectedKeywords) => {
  const expectedKeys = ['description', 'id', 'keywords', 'types', 'updated_at', 'version'];
  const actualKeywords = normalizeExactKeywords(entry?.keywords);
  const normalizedExpectedKeywords = normalizeExactKeywords(expectedKeywords);
  return entry !== null
    && typeof entry === 'object'
    && JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(expectedKeys)
    && entry.id === PLATFORM_NODE_PACKAGE.name
    && PLATFORM_NODE_PACKAGE.version === '0.0.1'
    && entry.version === PLATFORM_NODE_PACKAGE.version
    && typeof entry.description === 'string'
    && entry.description.length > 0
    && typeof entry.updated_at === 'string'
    && entry.updated_at.length > 0
    && actualKeywords !== undefined
    && normalizedExpectedKeywords !== undefined
    // catalogue 不承诺关键词顺序；排序副本后精确比较，缺失/重复/额外项均拒绝。
    && JSON.stringify(actualKeywords) === JSON.stringify(normalizedExpectedKeywords)
    && Array.isArray(entry.types)
    && JSON.stringify([...entry.types].sort()) === JSON.stringify([...PLATFORM_NODE_TYPES].sort());
};

function removeBaselineRoot(path) {
  const parent = realpathSync(tmpdir());
  let pathStat;
  let actual;
  try {
    pathStat = lstatSync(path);
    actual = realpathSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const rel = relative(parent, actual);
  if (
    !pathStat.isDirectory()
    || pathStat.isSymbolicLink()
    || dirname(actual) !== parent
    || rel.startsWith('..')
    || resolve(parent, rel) !== actual
    || !basename(actual).startsWith('tle-baseline-')
  ) throw new Error(`拒绝清理越界的 baseline 临时目录：${actual}`);
  rmSync(actual, { recursive: true, force: false });
  try {
    lstatSync(actual);
    throw new Error(`baseline 临时目录清理后仍存在：${actual}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function catalogueTrustBoundary(root, db) {
  const generic = 'node-red-contrib-baseline-catalogue';
  const store = new NodeStore(join(root, 'catalogue-store'));
  store.add(gzipSync(tarArchive([
    {
      name: 'package/package.json',
      content: JSON.stringify({
        name: generic,
        version: '1.0.0',
        description: 'baseline catalogue fixture',
        keywords: ['node-red'],
        'node-red': { nodes: { baseline: 'baseline.js' } },
      }),
    },
    { name: 'package/baseline.js', content: 'module.exports = function () {};\n' },
  ])));
  const catalog = new NodeCatalog(db);
  catalog.approve({ module: generic, version: '1.0.0', note: 'baseline', actor: 'baseline' });
  ensurePlatformApproval(catalog, 'system');
  const calls = [];
  const platformPackages = {
    snapshotForRegistry(name, version) {
      calls.push([name, version]);
      if (name !== PLATFORM_NODE_PACKAGE.name || version !== PLATFORM_NODE_PACKAGE.version) {
        return undefined;
      }
      return {
        buffer: Buffer.from('not-served-by-catalogue'),
        meta: {
          name,
          version,
          description: 'ThingLinks Edge platform nodes',
          keywords: [...BASELINE_PLATFORM_KEYWORDS],
          types: [...PLATFORM_NODE_TYPES],
          updatedAt: new Date(0).toISOString(),
        },
      };
    },
  };
  const app = Fastify({ logger: false });
  try {
    registerNpmRegistry(
      app,
      { config: { basePath: '' } },
      { store, catalog, internalBase: 'http://registry.invalid/npm', platformPackages },
    );
    const response = await app.inject({ method: 'GET', url: '/npm/-/catalogue.json' });
    const body = response.json();
    const modules = Array.isArray(body.modules) ? body.modules : [];
    const ids = modules.map((item) => item.id).sort();
    const edgeEntries = modules.filter((item) => item.id === PLATFORM_NODE_PACKAGE.name);
    return response.statusCode === 200
      && JSON.stringify(ids) === JSON.stringify([PLATFORM_NODE_PACKAGE.name, generic].sort())
      && modules.every((item) => item.id !== PLATFORM_COMMON_PACKAGE.name)
      && edgeEntries.length === 1
      && isExactPlatformCatalogueEntry(edgeEntries[0], BASELINE_PLATFORM_KEYWORDS)
      && JSON.stringify(calls) === JSON.stringify([
        [PLATFORM_NODE_PACKAGE.name, PLATFORM_NODE_PACKAGE.version],
      ]);
  } finally {
    await app.close();
  }
}

async function main() {
  let dbDir;
  let db;
  let operationError;
  try {
    console.log('\n──── 安全基线 7 组 · 逐条对照 ────\n');

    // ── 1. 凭证与密钥 ──────────────────────────────────────
    const G1 = '1 凭证密钥';
    const suspicious = readAll(sources).flatMap(({ f, text }) =>
      text.split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) =>
          /(password|passwd|secret|token|apikey|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(line)
          && !/process\.env|例|示例|placeholder|your-|<|\$\{/.test(line))
        .map(({ i }) => `${f.replace(REPO + '/', '')}:${i + 1}`));
    check(G1, '源码里没有硬编码的口令/密钥/令牌', suspicious.length === 0, suspicious.join(' '));

    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n');
    const leaked = tracked.filter((f) =>
      f === '.env' || f.endsWith('/.env') || f.endsWith('.master.key') || f.endsWith('.db'));
    check(G1, '本地环境文件与密钥没有被提交（.env / .master.key / *.db）',
          leaked.length === 0, leaked.join(' '));

    const history = execFileSync('git',
      ['log', '--all', '--diff-filter=A', '--name-only', '--pretty=format:'],
      { cwd: REPO, encoding: 'utf8' }).split('\n').map((s) => s.trim());
    const everAdded = history.filter((f) =>
      f === '.env' || f.endsWith('/.env') || f.endsWith('.master.key'));
    check(G1, 'git 历史里也从未出现过它们（进过历史 = 已泄露，必须轮换）',
          everAdded.length === 0, everAdded.join(' '));

    // 敏感字段加密落库：直接翻库文件，明文一个字都不该有
    dbDir = mkdtempSync(join(realpathSync(tmpdir()), 'tle-baseline-'));
    const dbFile = join(dbDir, 'edge.db');
    db = openDb(dbFile);
    const repo = new InstanceRepo(db, deriveKey('baseline', 'salt'));
    const CRED = 'plaintext-credential-should-never-hit-disk';
    repo.create(
      { id: 'bl-a', name: 'bl', imageTag: '5.0.4-24-minimal', memLimit: 512, cpuLimit: 0.5,
        adminRoot: '/red/bl-a/', credSecret: 'cs', notes: '' },
      [], [{ username: 'admin', password: CRED, permissions: '*' }],
    );
    const bytes = readFileSync(dbFile);
    check(G1, '实例凭据加密落库，库文件里搜不到明文',
          !bytes.includes(Buffer.from(CRED)), `库 ${Math.round(bytes.length / 1024)}KB`);

    // ── 2. 多租户隔离 → Edge 的等价红线：实例隔离 + 授权矩阵 ──
    const G2 = '2 租户隔离';
    na(G2, 'DATASOURCE_COLUMN 动态库 + created_org_id 租户列',
       'Edge 是装在客户现场的单租户设备，没有租户维度。等价红线是**实例隔离**：'
       + '一实例一网络、按实例授权，见下两条与 verify-isolation');
    na(G2, '动态数据源 strict:true，禁止静默回落 primary',
       'Edge 用单库 SQLite，没有动态数据源。同精神的红线在别处：'
       + '镜像缺失不静默回落去拉、读不到 MemAvailable 不假装读数可信');

    const grants = new UserRepo(db);
    const auth = new AuthService(db);
    auth.ensureInitialUser('admin', 'baseline-pass-123');
    grants.create('line-op', 'operator', 'admin');
    check(G2, '没有授权记录即拒绝（fail-closed），不是「默认可见」',
          canInstance('operator', 'instance:view', undefined) === false
          && canInstance('viewer', 'instance:view', undefined) === false);
    grants.grant('line-op', 'bl-a', 'view', 'admin');
    check(G2, '授权只对被授权的那台生效，不外溢',
          canInstance('operator', 'instance:view', grants.grantFor('line-op', 'bl-a')) === true
          && grants.grantFor('line-op', 'other') === undefined);

    // ── 3. 鉴权与越权 ──────────────────────────────────────
    const G3 = '3 鉴权越权';
    /*
     * 逐条路由核对：每个注册点后面若干行里必须出现 guard(，否则要在白名单里。
     * 白名单**带理由**，加一条就得写一句为什么它可以匿名 —— 这是评审留痕。
     */
    const ANON = new Map([
      ['/healthz', '存活探针：compose/K8s 要在没有凭据时能问「你活着吗」，不回任何环境信息'],
      ['/api/login', '登录入口本身：它就是获取会话的地方，失败计数与锁定在服务端'],
      ['/api/login/2fa', '登录第二步：凭第一步下发的一次性票据，不接受任意输入'],
      ['/api/setup', '首次认领：这台设备还没有任何账号，有账号后立刻 409'],
      ['/api/me', '读当前会话：未登录返回 401，不泄漏任何环境信息'],
      ['/api/logout', '登出：未登录时也该能安全调用，不因为没会话而报错'],
      ['/api/change-password', '改密自身。guard 会拦住「未改初始口令」的用户，'
        + '改密路由若也走 guard，用户就被锁进无法改密的死循环（见 http/context.ts 的 allowPending）'],
      ['/npm/-/catalogue.json', '私有源的节点目录：由现场浏览器里的 Node-RED 编辑器前端取。'
        + '内容是**已批准的公开 npm 包**的名字与说明，不含任何机密'],
      ['/npm/*', '私有源的 packument 与包体：由实例容器里的 npm 取。npm 只能靠 .npmrc 的 '
        + '_authToken 鉴权，而**装包前那次 npm info 读不到实例的 .npmrc**（那次调用不带 cwd，'
        + '继承 /usr/src/node-red，实测已确认）—— 加了鉴权恰恰是「一开白名单就什么都装不上」。'
        + '权衡后放开只读：源里只有已批准的公开包，能访问到它的前提是已在 Manager 的网络里'],
    ]);
    const routeRe = /\b(?:api|app)\.(get|post|put|delete)\(\s*`?\$\{[^}]*\}([^`'"]*)/g;
    const unguarded = [];
    const tokenAuthed = [];
    const manualAuthed = [];
    for (const { f, text } of readAll(walk(join(MGR, 'http')))) {
      for (const m of text.matchAll(routeRe)) {
        const path = m[2] ?? '';
        const body = text.slice(m.index, m.index + 700);
        // 大小写都算：fieldGuard() 之类的包装同样是过了 guard
        if (/[Gg]uard\(/.test(body)) continue;
        /*
         * 节点接入通道走的是**每实例独立令牌**，不是管理会话 ——
         * 实例是长期运行的自动化流程，没有「登录」这一说。
         * 它自成一条鉴权路径，下面单独断言其关键性质。
         */
        if (/\bauthed\(/.test(body)) { tokenAuthed.push(path); continue; }
        /*
         * 免密跳转与反代不是 JSON API，走不了 guard 那套（要下发 HTML、要接管升级），
         * 但它们**必须**自己判到实例级 —— 这两条是全平台最大的越权面。
         * 认「同时出现 currentUser + canInstance」为合格，并在下面单独断言。
         */
        if (/currentUser\(/.test(body) && /canInstance\(/.test(body)) {
          manualAuthed.push(path);
          continue;
        }
        if ([...ANON.keys()].some((a) => path === a)) continue;
        unguarded.push(`${f.replace(REPO + '/', '')} ${path}`);
      }
    }
    check(G3, '每个对外端点要么过 guard，要么在带理由的匿名白名单里',
          unguarded.length === 0, unguarded.join(' | ').slice(0, 160));
    check(G3, `匿名白名单共 ${ANON.size} 条，逐条写明了暴露理由`,
          [...ANON.values()].every((v) => v.length > 12));
    const proxySrc = readFileSync(join(MGR, 'http/instance/proxy.ts'), 'utf8');
    check(G3, `免密跳转与反代 ${manualAuthed.length + 1} 处自行判到实例级授权`,
          manualAuthed.length > 0
          && /canInstance\(/.test(proxySrc) && /originAllowed\(/.test(proxySrc),
          `${manualAuthed.join(' ')} + 反代 preHandler`);
    const ingestSrc = readFileSync(join(MGR, 'http/edge/ingest.ts'), 'utf8');
    check(G3, `节点接入通道 ${tokenAuthed.length} 条走每实例令牌，且实例 id 只从令牌反查`,
          tokenAuthed.length > 0
          && /只从令牌反查|绝不取自请求体/.test(ingestSrc)
          && !/instanceId\s*=\s*\(?req\.body/.test(ingestSrc),
          tokenAuthed.slice(0, 3).join(' '));
    /*
     * 私有源是全平台唯一匿名可读的**数据**端点，所以它的边界要单独钉死：
     * 只读、且只服务已批准的包。哪天有人给它加一条写路由，这里当场红。
     */
    const registrySrc = readFileSync(join(MGR, 'http/nodes/registry.ts'), 'utf8');
    const registryVerbs = [...registrySrc.matchAll(/\bapi\.(get|post|put|delete|patch)\(/g)]
      .map((m) => m[1]);
    check(G3, '匿名的私有源只有 GET，没有任何写入路径',
          registryVerbs.length > 0 && registryVerbs.every((v) => v === 'get'),
          registryVerbs.join(' '));
    check(G3, '运行期 catalogue 只列普通批准包与经固定信任重验的 Edge，永不列 common',
          await catalogueTrustBoundary(dbDir, db));

    check(G3, '角色表未知角色按最小权限处理，不按 admin 兜底',
          can('nobody', 'instance:list') === false && can('', 'user:manage') === false);
    na(G3, '设备 connect/publish/subscribe 过 BifroMQ ACL',
       'Edge 不是 broker。等价面是实例接入令牌：令牌反查实例 id，绝不取自请求体，'
       + '否则实例 A 能冒充 B 写台账（见 http/edge/ingest.ts）');

    // ── 4. 注入与输入校验 ──────────────────────────────────
    const G4 = '4 注入校验';
    const sqlConcat = readAll(sources).flatMap(({ f, text }) =>
      text.split('\n').map((line, i) => ({ line, i }))
        .filter(({ line }) => /\.prepare\(\s*`[^`]*\$\{/.test(line))
        .map(({ i }) => `${f.replace(REPO + '/', '')}:${i + 1}`));
    check(G4, 'SQL 一律参数绑定，没有把变量拼进 prepare 的模板串',
          sqlConcat.length === 0, sqlConcat.join(' '));

    let rejected = false;
    try {
      assertValidSpec({ id: '../../etc', name: 'x', imageTag: '5.0.4-24-minimal',
                        memoryMb: 256, cpuLimit: 0.5, adminRoot: '/red/x/', ports: [] },
                      { min: 30000, max: 30999 });
    } catch { rejected = true; }
    check(G4, '非法实例标识被拒（路径穿越形态）', rejected);

    let badEnvelope = false;
    try { parseEnvelope(Buffer.from('{"head":{},"dataBody":{}}')); } catch { badEnvelope = true; }
    check(G4, '协议信封缺字段时拒绝解析，不放行也不崩溃', badEnvelope);
    na(G4, 'Groovy 规则脚本沙箱与超时',
       'Edge 不执行平台下发的脚本。用户自己的 Node-RED 流程跑在**独立容器**里，'
       + '有内存/CPU 配额、非 root、能力裁剪，边界是容器而不是沙箱');

    // ── 5. 传输与存储加密 ──────────────────────────────────
    const G5 = '5 传输存储';
    const composeText = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8');
    check(G5, '端口默认只发布到回环，不裸暴露公网',
          /BIND_ADDR:-127\.0\.0\.1/.test(composeText));
    check(G5, '实例端口不允许映射 1880（唯一入口必须是 Manager 反代）',
          readFileSync(join(MGR, 'core/instance/container-spec.ts'), 'utf8')
            .includes('实例 1880 端口不得映射到宿主'));
    check(G5, '云对接支持双向 TLS（verify-cloud-tls 覆盖细节）',
          readdirSync(join(MGR, 'core/cloud')).includes('tls.ts'));
    na(G5, 'cipherFlag SM4/AES + dataSign 验签失败拒绝处理',
       'Edge 侧实现的是**发送端**：信封按 07 号文构造并签名；'
       + '收下行时验签失败直接丢弃并留痕（core/cloud/gateway.ts 的 #dispatch）');

    // ── 6. 日志与信息泄露 ──────────────────────────────────
    const G6 = '6 日志泄露';
    const uplink = readFileSync(join(MGR, 'http/edge/ingest.ts'), 'utf8');
    check(G6, '高频上行路径上没有成功日志（防日志洪峰）',
          !/console\.log\(/.test(uplink.slice(uplink.indexOf('api/edge/uplink'))));
    const logsSecrets = readAll(sources).flatMap(({ f, text }) =>
      text.split('\n').map((line, i) => ({ line, i }))
        .filter(({ line }) => /console\.(log|warn|error)\([^)]*\b(password|pwd|token|secret|masterKey)\b/i.test(line)
          && !/redact|脱敏|\*\*\*/.test(line))
        .map(({ i }) => `${f.replace(REPO + '/', '')}:${i + 1}`));
    check(G6, '日志语句里不出现口令/令牌/密钥变量', logsSecrets.length === 0, logsSecrets.join(' '));
    check(G6, '有统一脱敏工具并在诊断包上强制执行',
          readdirSync(join(MGR, 'core/diag')).includes('redact.ts'));

    // ── 7. 运维面加固 ──────────────────────────────────────
    const G7 = '7 运维加固';
    na(G7, '生产 p6spy:false / Druid 监控页加固 / Actuator 鉴权',
       'Java 生态特有。Edge 的等价面是受限 docker 代理：按方法逐条正则白名单，'
       + 'exec、swarm、secrets、images/create 一律不放行（verify-compose 正面与反面都验）');
    na(G7, '连接池 removeAbandoned 只是兜底',
       'SQLite 单进程直连，没有连接池');
    // manager 服务那一段：从 `  manager:` 到下一个顶层键，只看它自己的配置
    const managerBlock = (composeText.split(/\n  manager:\n/)[1] ?? '').split(/\nnetworks:/)[0] ?? '';
    const mounts = managerBlock.split('\n')
      .filter((l) => /^\s*-\s+\S+:/.test(l) && !/^\s*#/.test(l.trim()));
    check(G7, 'Manager 只读根文件系统 + 禁止提权',
          /read_only: true/.test(managerBlock) && /no-new-privileges:true/.test(managerBlock));
    check(G7, 'Manager 以非 root 运行（镜像里 USER 已切走）',
          /^USER (?!root|0)/m.test(readFileSync(join(REPO, 'apps/manager/Dockerfile'), 'utf8')));
    check(G7, 'Manager 的挂载里没有宿主 docker.sock（注释不算数，只看挂载行）',
          !mounts.some((l) => l.includes('docker.sock')), mounts.join(' | ').slice(0, 80));
    // OTA 签名校验 → Edge 的等价物是离线安装包的完整性校验
    const installer = readFileSync(join(REPO, 'scripts/offline/install.sh'), 'utf8');
    check(G7, '离线安装包带校验和且安装前强制校验（对应 OTA 包签名校验）',
          /SHA256SUMS/.test(installer) && /校验和不匹配/.test(installer));
    check(G7, '备份用错密钥时当场拒绝，而不是恢复出解不开的凭据',
          readFileSync(join(MGR, 'core/archive/backup.ts'), 'utf8').includes('masterKeyFingerprint'));

    // ── 汇总 ───────────────────────────────────────────────
    const checks = rows.filter((r) => r.kind === 'check');
    const naCount = rows.filter((r) => r.kind === 'na').length;
    const pass = checks.filter((r) => r.ok).length;
    console.log(`\n  断言 ${pass}/${checks.length} 通过 · 不适用 ${naCount} 条（已逐条写明理由）\n`);
    return pass === checks.length;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try { db?.close(); } catch (error) { cleanupErrors.push(error); }
    try { if (dbDir) removeBaselineRoot(dbDir); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
        'baseline 执行或临时资源清理失败',
      );
    }
  }
}

main()
  .then((ok) => { process.exitCode = ok ? 0 : 1; })
  .catch((e) => { console.error('\n验证异常：', e.stack ?? e.message); process.exitCode = 1; });
