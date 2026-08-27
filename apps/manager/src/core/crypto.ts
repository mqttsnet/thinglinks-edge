/**
 * 凭据处理 —— 三类凭据三种方式，不可混用。
 *
 * | 凭据                     | 处理           | 原因                              |
 * |--------------------------|----------------|-----------------------------------|
 * | 管理面登录口令           | 单向哈希       | 永不需要还原                      |
 * | 实例 Node-RED 凭据       | 可逆加密       | 免密跳转要取明文去换 access_token |
 * | 写入 settings.js 的口令  | bcrypt         | Node-RED adminAuth 的格式要求     |
 *
 * 主密钥缺失时拒绝启动 —— 静默回落到默认密钥是「看起来加密了其实没有」的典型陷阱。
 */
import {
  randomBytes, scryptSync, timingSafeEqual,
  createCipheriv, createDecipheriv,
} from 'node:crypto';

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

const KEY_LEN = 32;
const IV_LEN = 12;

/** 由主密钥派生工作密钥；用 KDF 而非直接哈希，避免弱主密钥直接成为密钥 */
export function deriveKey(masterKey: string, salt: string): Buffer {
  if (!masterKey) throw new CryptoError('主密钥为空');
  return scryptSync(masterKey, salt, KEY_LEN);
}

/** 读取主密钥；生产环境缺失即拒绝启动，绝不回落默认值 */
export function requireMasterKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env['MASTER_KEY']?.trim();
  if (key) return key;
  if (env['NODE_ENV'] === 'production') {
    throw new CryptoError(
      'MASTER_KEY 未提供，拒绝启动。它用于加密实例凭据，应由安装脚本生成随机值' +
        '并落到独立密钥文件（权限 0600），且不得与数据库同备份。',
    );
  }
  return 'dev-only-insecure-key';
}

// ── 管理面登录口令：单向哈希 ───────────────────────────────

export interface PasswordHash {
  hash: string;
  salt: string;
}

export function hashPassword(password: string): PasswordHash {
  const salt = randomBytes(16).toString('hex');
  return { hash: scryptSync(password, salt, KEY_LEN).toString('hex'), salt };
}

export function verifyPassword(password: string, stored: PasswordHash): boolean {
  const candidate = scryptSync(password, stored.salt, KEY_LEN);
  let expected: Buffer;
  try {
    expected = Buffer.from(stored.hash, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(candidate, expected);
}

// ── 实例凭据：可逆加密 ─────────────────────────────────────

/**
 * AES-256-GCM 加密。输出 iv.tag.ciphertext（均 base64），
 * GCM 自带完整性校验，篡改会在解密时失败而非静默返回错误明文。
 */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), out].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(packed: string, key: Buffer): string {
  const parts = packed.split('.');
  if (parts.length !== 3) throw new CryptoError('密文格式非法');
  const [iv, tag, data] = parts.map((s) => Buffer.from(s, 'base64'));
  if (!iv || !tag || !data) throw new CryptoError('密文格式非法');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new CryptoError('解密失败：密钥不匹配或密文已被篡改');
  }
}

/** 生成实例的随机口令；用于自动创建账号 */
export function generatePassword(bytes = 18): string {
  return randomBytes(bytes).toString('base64url');
}
