/**
 * 诊断包脱敏（T4.5）。
 *
 * 验收标准是硬的：**导出后 grep 检索包内无明文凭据**。
 *
 * 两条腿一起走，缺一条都漏：
 *
 *   1. **按已知值**：把运行时确实持有的秘密（MASTER_KEY、实例口令、接入令牌、
 *      会话 id）逐个替换掉。这条最可靠，但只覆盖我们知道的
 *   2. **按模式**：`口令：xxx`、`password=`、`token=`、`Authorization: Bearer` 等。
 *      这条覆盖不知道的 —— 比如用户在 flow 里写死的第三方密钥
 *
 * 一个真实的泄漏面：**旧版本**的 Manager 首次启动会把初始口令打进日志
 * （`[init] 已创建初始账号 admin，初始口令：…`）。现在不这么干了
 * （改成首次设置由人在页面上认领，见 http/auth/setup.ts），
 * **但那条模式一条都不能撤**：诊断包收的是数据目录里的历史日志，
 * 现场也还跑着没升级的旧版本；而那些口令我们今天已经不持有了，
 * 按已知值那条腿根本够不着，只能靠模式兜住。
 */

export const MASK = '***REDACTED***';

/**
 * 按模式脱敏。
 *
 * 每条规则只替换**值**，保留键名 —— 排障时「这里有个口令」本身是有用的信息，
 * 全抹掉会让人以为配置缺失。
 *
 * **约定：最后一个捕获组必须是待抹的值**，其余组原样拼回（见下面 redact 的回调）。
 * 值右边如果还有必须保留的字符（闭引号、URL 的 @），一律用**前瞻** `(?=...)`
 * 而不是再开一个捕获组 —— 开成捕获组会让它变成「最后一个组」，
 * 于是被抹掉的是那个分隔符，真正的秘密原样留在产物里。
 * 这种错不会报错，只会安静地漏，所以在这里写死。
 */
const PATTERNS: { re: RegExp; label: string }[] = [
  // 中文冒号与英文冒号都要认；值取到行尾或空白
  { re: /((?:口令|密码|密钥|令牌)\s*[：:]\s*)(\S+)/g, label: '中文口令字样' },
  // "? 出现两次各有分工：键名后那个吃掉 JSON 的闭引号（`"token": "..."`），
  // 值前那个记住开引号，末尾 (?=\3) 用前瞻确认闭引号但**不吃掉**它 ——
  // 吃掉的话产物会变成 `"token": "***REDACTED***`，少一个引号，JSON 直接坏掉。
  { re: /\b(password|passwd|pwd|secret|token|apikey|api_key|accesskey|access_key)\b("?\s*[=:]\s*)("?)([^\s",}]+)(?=\3)/gi,
    label: 'key=value' },
  { re: /\b(authorization)\b(\s*:\s*)(\S+\s+)?(\S+)/gi, label: 'Authorization 头' },
  { re: /\b([A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z_]*)(=)([^\s]+)/g, label: '环境变量' },
  // 形如 mqtt://user:pass@host 的 URL 凭据。
  // @ 必须是前瞻：写成捕获组它就成了「最后一个组」，被抹的是 @ 而口令原样留下。
  // 值排除 / 是防止跨过路径去匹配（http://a:b/c@d 里的 b 不是凭据）。
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(?=@)/gi, label: 'URL 内联凭据' },
];

/** 值太短就不按已知值替换：像 `1`、`ok` 这种会把正文打得千疮百孔 */
const MIN_SECRET_LEN = 8;

export interface RedactOptions {
  /** 运行时确实持有的秘密值 */
  secrets?: readonly (string | undefined)[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redact(text: string, opts: RedactOptions = {}): string {
  let out = text;

  // 先按已知值：它最准，且能覆盖模式认不出的形态（比如口令单独出现在一行）
  const secrets = [...new Set((opts.secrets ?? []).filter(
    (s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LEN,
  ))].sort((a, b) => b.length - a.length);          // 长的先替，避免短的把长的截断
  for (const s of secrets) {
    out = out.replace(new RegExp(escapeRe(s), 'g'), MASK);
  }

  for (const { re } of PATTERNS) {
    out = out.replace(re, (...args) => {
      const groups = args.slice(0, -2) as string[];
      // 约定：最后一个捕获组是「值」，其余原样保留
      const value = groups[groups.length - 1] ?? '';
      if (value === MASK || value.length === 0) return groups[0]!;
      const head = groups.slice(1, -1).join('');
      return head + MASK;
    });
  }
  return out;
}

/** 递归脱敏对象里的字符串。键名命中敏感词时整值替换，不看内容 */
const SENSITIVE_KEY = /pass|pwd|secret|token|key|cred|salt|hash|authorization/i;

export function redactValue(value: unknown, opts: RedactOptions = {}): unknown {
  if (typeof value === 'string') return redact(value, opts);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, opts));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? MASK : redactValue(v, opts);
    }
    return out;
  }
  return value;
}

/**
 * 诊断包自检：扫一遍产物里还有没有已知秘密。
 *
 * 这是**最后一道闸**。脱敏逻辑再周全也可能漏掉新增字段，
 * 所以导出前一律再扫一次；发现残留就拒绝导出，而不是带着凭据发出去。
 */
export function assertNoSecrets(content: string, secrets: readonly (string | undefined)[]): void {
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= MIN_SECRET_LEN && content.includes(s)) {
      throw new Error(`诊断包仍含明文凭据（长度 ${s.length}），已拒绝导出`);
    }
  }
}
