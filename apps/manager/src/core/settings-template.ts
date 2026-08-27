/**
 * 生成实例的 Node-RED settings.js。
 *
 * 两个关键点：
 * 1. httpAdminRoot 必须带 basePath —— 外层反代挂子路径时前缀要一路带进实例，
 *    否则编辑器静态资源与 WebSocket 丢前缀。已在真实 Node-RED 5.0.4 验证。
 * 2. adminAuth 用原生静态凭据（bcrypt），不依赖任何 contrib 包 ——
 *    上游 PoC 依赖的 auth-mongodb / storage-mongodb 已停更 5~6 年，
 *    锁死在 Node-RED 1.x API 上，是「安装时选版本」做不了的根因。
 */

export interface InstanceCredential {
  username: string;
  /** bcrypt 哈希，非明文 */
  passwordHash: string;
  permissions: '*' | 'read';
}

export interface SettingsInput {
  instanceId: string;
  /** 形如 /nodered/red/line-a/ ，必须以斜杠结尾 */
  adminRoot: string;
  credentials: InstanceCredential[];
  /** 加密 flow 内凭据的密钥；由 Manager 生成并保管，备份恢复需要 */
  credentialSecret: string;
  /**
   * 屏蔽内置高危节点。Function 节点本身就是容器内 RCE，
   * 真正的防线是容器隔离；屏蔽 exec 等只是降低随手滥用的门槛，可关闭。
   */
  excludeRiskyNodes?: boolean;
}

const RISKY_NODES = ['90-exec.js', '28-tail.js', '10-file.js', '23-watch.js'];

/** JS 字符串字面量转义，防止值内容破坏生成的文件结构 */
function js(value: string): string {
  return JSON.stringify(value);
}

export function renderSettings(input: SettingsInput): string {
  if (!input.adminRoot.endsWith('/')) {
    throw new Error(`adminRoot 必须以斜杠结尾，收到 ${input.adminRoot}`);
  }
  if (input.credentials.length === 0) {
    throw new Error('至少需要一个实例账号');
  }
  for (const c of input.credentials) {
    if (!/^\$2[aby]\$\d{2}\$/.test(c.passwordHash)) {
      throw new Error(`账号 ${c.username} 的口令必须是 bcrypt 哈希，不接受明文`);
    }
  }

  const users = input.credentials
    .map((c) => `        { username: ${js(c.username)}, password: ${js(c.passwordHash)}, permissions: ${js(c.permissions)} }`)
    .join(',\n');

  const excludes = input.excludeRiskyNodes === false ? '[]' : JSON.stringify(RISKY_NODES);

  return `/**
 * 由 ThingLinks Edge 自动生成 —— 请勿手工修改。
 * 实例：${input.instanceId}
 * 账号与端口由管理台统一管理，实例侧无独立配置入口。
 */
module.exports = {
    uiPort: process.env.PORT || 1880,

    // 前缀必须与 Manager 反代一致；代理层不做路径重写
    httpAdminRoot: ${js(input.adminRoot)},
    httpNodeRoot: ${js(input.adminRoot + 'api/')},

    adminAuth: {
        type: "credentials",
        users: [
${users}
        ]
    },

    credentialSecret: ${js(input.credentialSecret)},
    flowFile: "flows.json",
    flowFilePretty: true,

    // 不启用外部模块，收敛 Function 节点的可达面
    functionExternalModules: false,
    functionGlobalContext: {},
    nodesExcludes: ${excludes},

    logging: {
        console: { level: "info", metrics: false, audit: false }
    },

    editorTheme: {
        projects: { enabled: false },
        page: { title: ${js(input.instanceId)} },
        header: { title: ${js(input.instanceId)} },
        palette: { upload: false }
    }
};
`;
}
