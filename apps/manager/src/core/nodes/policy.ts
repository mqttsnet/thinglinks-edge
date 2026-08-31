/**
 * 把「已批准节点清单」翻译成 Node-RED 的安装管控配置（01 号文 5.7）。
 *
 * 这个文件存在的唯一理由，是 Node-RED 5.0.4 的白名单语义**与直觉相反**，
 * 而写错的表现是「配了白名单，界面上也照常显示受限，实际什么都装得上」——
 * 一个静默失效的安全配置，比没有配置更危险。上一版就是这么失效的。
 *
 * 下面每条都在真实的 `nodered/node-red:5.0.4-24-minimal` 上实测过，
 * 不是照文档抄的。文档在这几点上不足以得出正确配置。
 *
 * ## 一、只写 allowList 等于没写
 *
 * `@node-red/registry/lib/installer.js` 里：
 *
 *     installAllAllowed = installDenyList.length === 0;      // ← 只看 denyList
 *     ...
 *     if (!installAllAllowed) {                              // ← 白名单校验在这里面
 *         if (!checkModuleAllowed(...)) throw "install_not_allowed";
 *     }
 *
 * denyList 为空 ⇒ `installAllAllowed` 为真 ⇒ **整段校验根本不执行**。
 * 实测：`allowList:['node-red-node-random'], denyList:[]` 之下
 * `POST /nodes {module:'node-red-contrib-cpu'}` 回 200，包真的装上了。
 *
 * 就算校验执行了，`checkModuleAllowed` 里还有第二道「两边都没命中 ⇒ 放行」：
 *
 *     if (!allowedRule && !deniedRule) return true;
 *
 * 所以**必须显式拒全部，再逐条放行**。
 *
 * ## 二、`denyList:['*']` 不会把白名单里的也拒掉
 *
 * 两边都命中时按 `wildcardPos` 决胜，而 `parseModuleList` 给不含 `*`
 * 的精确名记的是 `Infinity`、给 `*` 记的是 `0`：
 *
 *     wildcardPos = m[1].indexOf("*");  wildcardPos = wildcardPos===-1 ? Infinity : wildcardPos;
 *     ...
 *     if (allowedRule.wildcardPos !== deniedRule.wildcardPos)
 *         return allowedRule.wildcardPos > deniedRule.wildcardPos;   // Infinity > 0 ⇒ 放行
 *
 * 实测同一份配置下 `node-red-contrib-cpu` 回 400 `install_not_allowed`、
 * 白名单内的模块回 200。
 *
 * ## 三、catalogue 不显式覆盖就还挂着公网源
 *
 * 编辑器前端：
 *
 *     catalogues = RED.settings.theme('palette.catalogues') || ['https://catalogue.nodered.org/catalogue.json']
 *
 * 离线现场不覆盖它，节点管理面板会一直转圈等一个连不上的地址。
 *
 * ## 四、上传拦截认的是 `externalModules.palette.allowUpload`
 *
 * 老写法 `editorTheme.palette.upload:false` 在 5.0.4 **已经拦不住**：
 * 实测带着它 POST 一个 tgz，请求照样走到解包阶段（回 `TAR_BAD_ARCHIVE`），
 * 与什么都不配的对照组表现一致。真正生效的是
 * `editor-api/lib/admin/index.js` 与 `installer.js:426` 读的 `allowUpload`。
 *
 * ## 五、私有源必须靠环境变量，不能只靠 .npmrc
 *
 * 见 {@link registryEnv}。
 */

/** 已批准的一条节点 */
export interface ApprovedModule {
  /** npm 包名，如 node-red-contrib-modbus */
  module: string;
  /**
   * 允许的版本范围（semver）。留空表示不限版本。
   *
   * 限版本是有代价的：`checkModuleAllowed` 只在**规则带版本**时才去比对，
   * 而比对用的版本来自一次 `npm info` 请求（见 registryEnv 的说明）。
   */
  version?: string | undefined;
}

/** 生成进 settings.js 的安装管控配置 */
export interface PalettePolicy {
  /** 是否允许实例侧自助安装节点。false 时编辑器连面板都不显示 */
  allowInstall: boolean;
  allowList: string[];
  denyList: string[];
  /** 私有 catalogue 地址；空数组表示编辑器里不提供可浏览的节点目录 */
  catalogues: string[];
}

/**
 * 一条规则的字面量形式：`name` 或 `name@range`。
 *
 * 包名不做转义 —— Node-RED 会把它拼进 `new RegExp("^" + rule.replace(星号, ".*") + "$")`，
 * 所以**包名里的正则元字符是有意义的**，必须在入库前就挡住（见 assertModuleName）。
 */
function ruleOf(m: ApprovedModule): string {
  return m.version ? `${m.module}@${m.version}` : m.module;
}

/**
 * npm 包名合法性。
 *
 * 除了 npm 自己的命名规则，这里额外**只允许**一个保守字符集：
 * 规则字符串最终会被拼进正则（见 ruleOf 的说明），
 * 放进 `.` 之外的元字符会让一条白名单意外匹配到别的包。
 * npm 包名本来就不允许这些字符，收紧不会误伤真实的包。
 */
const MODULE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export class NodePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodePolicyError';
  }
}

export function assertModuleName(module: string): void {
  if (module.length > 214) {
    throw new NodePolicyError(`包名过长（npm 上限 214 字符）：${module.slice(0, 40)}…`);
  }
  if (!MODULE_RE.test(module)) {
    throw new NodePolicyError(
      `包名非法：${JSON.stringify(module)}。只允许小写字母、数字与 . _ -，`
      + '可带一层 @scope/ 前缀。通配符不接受 —— 白名单里放通配符等于没有白名单',
    );
  }
}

/**
 * 版本范围合法性。
 *
 * 只做字符集校验，不引 semver 解析：这里拦的是「别把奇怪东西拼进规则」，
 * 真正的范围匹配由 Node-RED 侧的 semver 做，两边各司其职。
 */
export function assertVersionRange(range: string): void {
  if (!/^[0-9a-zA-Z.\-+~^*<>=|\s]{1,64}$/.test(range)) {
    throw new NodePolicyError(`版本范围非法：${JSON.stringify(range)}`);
  }
}

/**
 * 由已批准清单生成策略。
 *
 * `catalogueUrl` 留空表示这个部署不提供节点目录 —— 此时编辑器的节点管理面板
 * 搜不到任何东西，但**白名单内的包仍然装得上**（直接填包名即可）。
 * 这正是纯离线现场的形态：目录是锦上添花，白名单才是闸门。
 */
export function buildPolicy(
  approved: readonly ApprovedModule[],
  opts: { allowInstall: boolean; catalogueUrl?: string | undefined },
): PalettePolicy {
  const allowList = approved.map(ruleOf);

  return {
    allowInstall: opts.allowInstall,
    allowList,
    /*
     * 恒为 ['*']，**即使白名单是空的**。
     *
     * 空 denyList 会让整段校验被跳过（见文件头第一条），那时候
     * 「白名单为空」的含义会从「什么都不许装」翻转成「什么都能装」——
     * 恰恰在管理员还没批准任何节点的初始状态下门是敞开的。
     */
    denyList: ['*'],
    catalogues: opts.catalogueUrl ? [opts.catalogueUrl] : [],
  };
}

/**
 * 实例容器要注入的 npm 环境变量。
 *
 * **为什么不是往 /data/.npmrc 里写 `registry=`**：
 *
 * 开了白名单之后，Node-RED 装包前会先跑一次
 * `npm info --json -- <name>` 去核实版本存在（installer.js:379）。
 * 那次调用是 `child_process.execFile(...)` **不带 cwd** 的，
 * 于是继承进程 cwd —— 实测官方镜像里是 `/usr/src/node-red`，不是 `/data`。
 * 而 npm 的 .npmrc 是按 cwd 逐级向上找的。
 *
 * 实测同一个容器内：
 *
 *     cd /data            && npm config get registry  → http://127.0.0.1:9/   （读到了）
 *     cd /usr/src/node-red && npm config get registry  → https://registry.npmjs.org/（没读到）
 *
 * 所以只写 .npmrc 的话，**恰恰是在开启白名单之后**，版本预检会绕过私有源
 * 直奔公网 npmjs.org —— 离线现场表现为「白名单一开，什么都装不上了」，
 * 而报错是含糊的 "Version not found"。
 *
 * 环境变量不受 cwd 影响，两条路径都覆盖，所以用它。
 */
export function registryEnv(registryUrl: string): string[] {
  if (!registryUrl) return [];
  return [
    `NPM_CONFIG_REGISTRY=${registryUrl}`,
    /*
     * 私有源是 http 明文（同一 docker 网络内，见 http/nodes/registry.ts 的说明）。
     * npm 对非 https 源默认只警告不拒绝，但把这条显式写出来，
     * 免得将来换了 npm 大版本收紧策略时，故障现象又是一句「装不上」。
     */
    'NPM_CONFIG_STRICT_SSL=false',
    // 离线现场没有审计源可查；不关掉会让每次安装多等一次必然失败的请求
    'NPM_CONFIG_AUDIT=false',
    'NPM_CONFIG_FUND=false',
    'NPM_CONFIG_UPDATE_NOTIFIER=false',
  ];
}
