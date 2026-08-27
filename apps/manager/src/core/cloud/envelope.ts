/**
 * ThingLinks 云侧协议信封。
 *
 * 上行报文不是裸 JSON，必须包成 `head` / `dataBody` / `dataSign` 三段，
 * 否则云端 `validateProtocolData` 直接判定格式非法并丢弃。
 *
 * 本文件严格对齐云侧 `ProtocolMessageSignatureVerifierUtils`（thinglinks-util-pro），
 * 逐条核对过实现而不是照文档抄：
 *
 *   · `dataSign = sha256Hex(timeStamp + ":" + signKey)` —— 注意它**不覆盖报文体**，
 *     只是时间戳与密钥的摘要。所以它防的是「不知道 signKey 的人伪造报文」，
 *     不防「报文体被篡改」。别把它当成完整性校验用
 *   · `cipherFlag` 0=明文 / **1=SM4** / 2=AES —— 1 是 SM4 不是 AES，
 *     07 号文早期写反过
 *   · 明文时 `dataBody` 是**对象**；加密时是 **HEX 字符串**（云侧用
 *     `JSONUtil.isTypeJSON` 判断后决定塞对象还是塞字符串，等价于此）
 *   · 密钥与向量取字符串的 **UTF-8 字节**，CBC + PKCS5Padding，输出**小写 HEX**
 */
import { createHash, createCipheriv, createDecipheriv } from 'node:crypto';

/** 0 明文 · 1 SM4 · 2 AES */
export type CipherFlag = 0 | 1 | 2;

export interface EnvelopeHead {
  cipherFlag: CipherFlag;
  mid: number;
  timeStamp: number;
}

export interface Envelope {
  head: EnvelopeHead;
  dataBody: unknown;
  dataSign: string;
}

export interface CipherParams {
  cipherFlag: CipherFlag;
  signKey: string;
  /** cipherFlag 非 0 时必填 */
  encryptKey?: string | undefined;
  encryptVector?: string | undefined;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

/** `sha256Hex(timeStamp + ":" + signKey)`，小写十六进制 */
export function dataSignOf(timeStamp: number, signKey: string): string {
  return createHash('sha256').update(`${timeStamp}:${signKey}`, 'utf8').digest('hex');
}

/**
 * 生成 mid。
 *
 * 云侧 mid 是 64 位 long，而 JS number 只能精确表示 2^53 以内的整数 ——
 * 直接塞雪花值会在序列化时丢低位，且丢得**没有任何报错**。
 * 这里用「毫秒 × 1000 + 毫秒内序号」，量级约 1.8e15，稳在 2^53（9.0e15）以内，
 * 同时保证单调递增。同一毫秒超过 1000 条时借用下一毫秒，不回退、不重复。
 */
let lastMs = 0;
let seq = 0;
export function nextMid(now: number = Date.now()): number {
  if (now > lastMs) {
    lastMs = now;
    seq = 0;
  } else if (++seq > 999) {
    lastMs += 1;
    seq = 0;
  }
  return lastMs * 1000 + seq;
}

function algorithmFor(flag: CipherFlag, keyBytes: number): string {
  if (flag === 1) return 'sm4-cbc';
  return `aes-${keyBytes * 8}-cbc`;
}

/** 校验密钥材料长度，与云侧 `validateKeyMaterial` 同规则 */
function keyMaterial(params: CipherParams): { key: Buffer; iv: Buffer; algorithm: string } {
  const { cipherFlag, encryptKey, encryptVector } = params;
  if (!encryptKey || !encryptVector) {
    throw new EnvelopeError(`cipherFlag=${cipherFlag} 需要 encryptKey 与 encryptVector`);
  }
  const key = Buffer.from(encryptKey, 'utf8');
  const iv = Buffer.from(encryptVector, 'utf8');

  const allowed = cipherFlag === 1 ? [16] : [16, 24, 32];
  if (!allowed.includes(key.length)) {
    throw new EnvelopeError(
      `${cipherFlag === 1 ? 'SM4' : 'AES'} 密钥必须是 ${allowed.join('/')} 字节（UTF-8），实际 ${key.length}`,
    );
  }
  if (iv.length !== 16) {
    throw new EnvelopeError(`初始向量必须是 16 字节（UTF-8），实际 ${iv.length}`);
  }
  return { key, iv, algorithm: algorithmFor(cipherFlag, key.length) };
}

/**
 * 对外的参数校验入口。
 *
 * 存在的意义是**只有一份长度规则**：配置入库前要校验，加解密时也要校验，
 * 两处各写一遍必然漂移 —— 漂移的表现是「界面说配置合法，运行时才报密钥长度不对」。
 * cipherFlag=0 不需要密钥材料，直接放行。
 */
export function validateCipherParams(params: CipherParams): void {
  if (params.cipherFlag === 0) return;
  keyMaterial(params);
}

function encryptHex(plain: string, params: CipherParams): string {
  const { key, iv, algorithm } = keyMaterial(params);
  const c = createCipheriv(algorithm, key, iv);
  return c.update(plain, 'utf8', 'hex') + c.final('hex');
}

function decryptHex(hex: string, params: CipherParams): string {
  const { key, iv, algorithm } = keyMaterial(params);
  const d = createDecipheriv(algorithm, key, iv);
  return d.update(hex, 'hex', 'utf8') + d.final('utf8');
}

/** 把业务报文包成信封。`mid` / `timeStamp` 可注入，便于测试与响应沿用源 mid */
export function buildEnvelope(
  payload: unknown,
  params: CipherParams,
  opts: { mid?: number; timeStamp?: number } = {},
): Envelope {
  const timeStamp = opts.timeStamp ?? Date.now();
  const mid = opts.mid ?? nextMid();
  const json = JSON.stringify(payload);

  return {
    head: { cipherFlag: params.cipherFlag, mid, timeStamp },
    dataBody: params.cipherFlag === 0 ? payload : encryptHex(json, params),
    dataSign: dataSignOf(timeStamp, params.signKey),
  };
}

/**
 * 结构校验，与云侧 `validateProtocolData` 同规则：
 * 含 head 对象与 dataSign 字符串，`mid` / `timeStamp` 均大于 0，`cipherFlag` 在 0..2。
 */
export function validateEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['dataSign'] !== 'string') return false;
  const head = v['head'];
  if (typeof head !== 'object' || head === null) return false;
  const h = head as Record<string, unknown>;
  const mid = Number(h['mid']);
  const ts = Number(h['timeStamp']);
  const flag = Number(h['cipherFlag']);
  return mid > 0 && ts > 0 && Number.isInteger(flag) && flag >= 0 && flag <= 2;
}

/**
 * 拆信封并保留 head。
 *
 * 请求/响应要靠 `mid` 关联 —— 云侧 `buildResponse(src, ...)` 沿用源 mid，
 * 这是把 `topo/addResponse` 对回某一次 `topo/add` 的唯一依据。
 */
export function parseEnvelopeFull<T = unknown>(
  raw: string | Buffer,
  params: CipherParams,
): { head: EnvelopeHead; body: T } {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    throw new EnvelopeError('报文不是合法 JSON');
  }
  if (!validateEnvelope(value)) throw new EnvelopeError('报文不符合信封结构');

  const { head, dataBody, dataSign } = value;
  // 与云侧一致：dataSign 非空才校验（云侧允许空签名放行）
  if (dataSign !== '' && dataSign !== dataSignOf(Number(head.timeStamp), params.signKey)) {
    throw new EnvelopeError('dataSign 校验失败');
  }

  const flag = Number(head.cipherFlag) as CipherFlag;
  const normalizedHead: EnvelopeHead = {
    cipherFlag: flag,
    mid: Number(head.mid),
    timeStamp: Number(head.timeStamp),
  };

  if (flag === 0) return { head: normalizedHead, body: dataBody as T };

  if (typeof dataBody !== 'string') {
    throw new EnvelopeError(`cipherFlag=${flag} 时 dataBody 应为 HEX 字符串`);
  }
  return {
    head: normalizedHead,
    body: JSON.parse(decryptHex(dataBody, { ...params, cipherFlag: flag })) as T,
  };
}

/** 只要业务报文时用这个 */
export function parseEnvelope<T = unknown>(raw: string | Buffer, params: CipherParams): T {
  return parseEnvelopeFull<T>(raw, params).body;
}
