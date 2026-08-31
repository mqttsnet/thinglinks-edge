/**
 * 生成实例的 Node-RED settings.js。
 *
 * 两个关键点：
 * 1. httpAdminRoot 必须带 basePath —— 外层反代挂子路径时前缀要一路带进实例，
 *    否则编辑器静态资源与 WebSocket 丢前缀。已在真实 Node-RED 5.0.4 验证。
 * 2. adminAuth 用原生静态凭据（bcrypt），不依赖任何 contrib 包 ——
 *    上游 PoC 依赖的 auth-mongodb / storage-mongodb 已停更 5~6 年，
 *    锁死在 Node-RED 1.x API 上，是「安装时选版本」做不了的根因。
 * 3. 节点安装管控（externalModules）的取值**违反直觉**，改之前先读
 *    core/nodes/policy.ts 的文件头 —— 那里记着每一条的实测依据。
 *    尤其别把 denyList 清空「因为看起来多余」：清空之后整段白名单校验
 *    会被跳过，而界面上一切正常。
 */
import type { PalettePolicy } from '../nodes/policy.ts';

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
  /**
   * 节点安装管控。**不传即最严**：不许装任何东西。
   *
   * 默认值刻意选在这一侧 —— 漏传的后果是「装不上，来问」，
   * 而反过来是「谁都能装任意包，没人发现」。前者会被立刻发现并修好。
   */
  palette?: PalettePolicy | undefined;
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
  // 不传 palette 就是「什么都不许装」——见 SettingsInput.palette 的说明
  const palette: PalettePolicy = input.palette
    ?? { allowInstall: false, allowList: [], denyList: ['*'], catalogues: [] };

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

    // @thinglinks 节点集：由 Manager 拷进数据目录，扫目录加载，不走 npm
    nodesDir: "/data/nodes",

    // 不启用外部模块，收敛 Function 节点的可达面
    functionExternalModules: false,
    functionGlobalContext: {},
    nodesExcludes: ${excludes},

    logging: {
        console: { level: "info", metrics: false, audit: false }
    },

    /*
     * 节点安装管控（01 号文 5.7）。三个键缺一不可，取值理由见
     * core/nodes/policy.ts —— 每条都在真实 5.0.4 上验过。
     *
     *   denyList  恒为 ["*"]。它为空时 Node-RED 会把整段白名单校验**跳过**，
     *             届时 allowList 写什么都没用（installAllAllowed 只看 denyList）
     *   allowList 已批准清单。与 denyList 同时命中时按「通配符位置靠后者胜」
     *             决胜，精确包名记为 Infinity，所以能从 "*" 里捞出来
     *   allowUpload  这才是拦 tgz 上传的键。老写法 editorTheme.palette.upload
     *             在 5.0.4 已经拦不住（实测请求照样走到解包阶段）
     */
    externalModules: {
        autoInstall: false,
        palette: {
            allowInstall: ${palette.allowInstall ? 'true' : 'false'},
            allowList: ${JSON.stringify(palette.allowList)},
            denyList: ${JSON.stringify(palette.denyList)},
            allowUpload: false,
            allowUpdate: false
        },
        // Function 节点自带依赖：与 functionExternalModules:false 是同一件事的两面，
        // 两处都关掉，免得将来有人只改了上面那个就以为收敛了
        modules: {
            allowInstall: false,
            allowList: [],
            denyList: ["*"]
        }
    },

    editorTheme: {
        projects: { enabled: false },
        page: { title: ${js(input.instanceId)} },
        header: { title: ${js(input.instanceId)} },
        palette: {
            /*
             * 私有节点目录。不显式给的话，编辑器会回落到 Node-RED 官方的公网目录
             * （地址写死在 red.js 里），离线现场就是一直转圈。
             *
             * 这个地址是**浏览器**去取的（编辑器前端发起），所以填的是
             * 外部可见路径 —— 与实例里 npm 用的容器名地址不是一个东西。
             *
             * 注意别在这个文件里写出官方目录的域名字面量：验证脚本会检查
             * 生成的 settings.js 中不含它，用来确保没有哪台实例还挂着公网源。
             */
            catalogues: ${JSON.stringify(palette.catalogues)}
        }
    }
};
`;
}
