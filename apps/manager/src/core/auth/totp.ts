/**
 * TOTP（RFC 6238）与恢复码。
 *
 * 自己实现而不是引依赖：算法本身就是「HMAC-SHA1 + 取 4 字节 + 取模」，
 * 二十行的事，而离线安装是既定目标 —— 为这点东西多背一个包，
 * 现场断网时要多一个可能装不上的理由。Base32 同理，标准库里没有。
 *
 * 三处安全细节，缺一条都会让这层验证变成摆设：
 *
 *   1. **比对必须是定时的**。逐字符比较会让攻击者靠响应时间一位一位试出验证码 ——
 *      六位数字本来就只有一百万种，再漏时间信息就基本等于没有。
 *   2. **用过的时间步不能再用**。TOTP 一个码有 30 秒有效期，中间人截到之后
 *      在窗口内重放是能成功的。记住上次用过的步数、只接受更大的，
 *      重放就断在这里（`verifyTotp` 回的 `step` 就是给调用方存的）。
 *   3. **窗口只放 ±1 步**。放宽到 ±2、±3 能少几个「验证码不对」的工单，
 *      代价是把可重放的时间窗成倍拉长。边缘盒子时钟不准是常事，但那该靠对时解决，
 *      不该靠把门开大。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class TotpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpError';
  }
}

/** RFC 6238 的默认参数。改这几个值等于换一套码，已绑定的设备会全部失效 */
export const STEP_SECONDS = 30;
export const DIGITS = 6;
/** 允许的时钟偏差步数。±1 步 = ±30 秒 */
export const WINDOW_STEPS = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32，不补 `=` —— otpauth:// 的 secret 参数按惯例不带填充 */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  // 用户从别处粘过来的密钥常带空格和小写，先归一化再解，省得报一句「密钥无效」
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new TotpError(`密钥含非 Base32 字符：${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 新密钥。20 字节 = SHA-1 的块长，RFC 4226 建议的下限就是它 */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** 当前时间落在第几个时间步。抽出来是为了让测试能钉死某一步 */
export function stepAt(at: number = Date.now()): number {
  return Math.floor(at / 1000 / STEP_SECONDS);
}

/** 算某一步的验证码。返回定长字符串，前导零要保留 */
export function codeAt(secret: string, step: number): string {
  const key = base32Decode(secret);
  // 空密钥必须在这里挡住，不能只靠调用方：HMAC 接受空密钥，会**照常算出**
  // 一个六位数字。没绑定的账号于是有了一个「看起来合法」的验证码
  if (key.length === 0) throw new TotpError('密钥为空');
  // 8 字节大端计数器。步数早已超过 32 位能表示的秒数，必须写满 64 位
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  // 动态截断（RFC 4226 §5.3）：用最后一字节的低 4 位当偏移量
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24)
    | ((mac[offset + 1]! & 0xff) << 16)
    | ((mac[offset + 2]! & 0xff) << 8)
    | (mac[offset + 3]! & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** 定时比较。长度不同直接判否 —— timingSafeEqual 长度不等会抛，不能让它抛到调用方 */
function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export interface VerifyResult {
  ok: boolean;
  /** 命中的时间步。调用方要把它存下来，用于挡住同一个码的重放 */
  step: number;
}

/**
 * 校验验证码。
 *
 * `lastStep` 是这个账号上次成功用掉的步数，传进来就能挡住重放 ——
 * 同一个码在 30 秒内被第二次提交时，命中的步数不会大于它。
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { at?: number; lastStep?: number; window?: number } = {},
): VerifyResult {
  const digits = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${DIGITS}}$`).test(digits)) return { ok: false, step: 0 };

  const now = stepAt(opts.at ?? Date.now());
  const window = opts.window ?? WINDOW_STEPS;
  const lastStep = opts.lastStep ?? 0;

  /*
   * 密钥坏了也只回「不通过」，绝不抛。
   *
   * 这个函数在登录路径上，密钥来自库里 —— 库被改坏、或者密钥根本没绑，
   * 抛出去就是一个 500。用户看到「服务器错误」而不是「验证码不对」，
   * 排查方向立刻被带偏，而真正的原因（密钥不对）反而没人看得见。
   */
  try {
    for (let d = -window; d <= window; d += 1) {
      const step = now + d;
      if (step <= lastStep) continue;            // 重放：这一步用过了
      if (sameCode(codeAt(secret, step), digits)) return { ok: true, step };
    }
  } catch {
    return { ok: false, step: 0 };
  }
  return { ok: false, step: 0 };
}

/**
 * 绑定用的 otpauth:// 地址。
 *
 * `issuer` 同时出现在路径和查询里是规范要求的写法（Google Authenticator
 * 只认路径那份，1Password 一类只认查询那份），少一个就会有客户端显示成
 * 「未知账户」，而用户看到的只是列表里多了一条认不出的条目。
 */
export function otpauthUrl(opts: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const q = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** 手输时按四位一组断开，肉眼抄不容易串行 */
export function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

// ── 恢复码 ────────────────────────────────────────────────

export const RECOVERY_CODE_COUNT = 10;

/**
 * 恢复码用 SHA-256 存，不用 scrypt。
 *
 * 理由是它**不是用户选的口令**：10 组随机 Base32，熵远超任何人能记住的密码，
 * 离线爆破不成立，慢哈希在这里买不到安全性，只会让一次校验要跑十遍 scrypt。
 * 同样的道理，实例接入令牌那边也没上慢哈希。
 */
export function hashRecoveryCode(code: string): string {
  return createHmac('sha256', 'thinglinks-edge:recovery').update(normalizeRecovery(code)).digest('hex');
}

/** 归一化：去掉分隔符与大小写差异，用户抄回来的形态五花八门 */
export function normalizeRecovery(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/** 生成一组恢复码。形如 `A1B2-C3D4-E5F6`，抄写和输入都不容易错 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = base32Encode(randomBytes(8)).slice(0, 12);
    codes.push((raw.match(/.{1,4}/g) ?? []).join('-'));
  }
  return codes;
}
