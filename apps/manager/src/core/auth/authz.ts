/**
 * 授权：角色 + 实例授权矩阵（T4.4）。
 *
 * 两层，缺一不可：
 *   · **角色**决定「能做哪类事」——建实例、管用户、跑备份
 *   · **实例矩阵**决定「能对哪几台实例做」——现场常见一个班组只管自己那条线
 *
 * 只有角色而没有矩阵，等于给了运维全厂的启停权；
 * 只有矩阵而没有角色，管不住「谁能建实例、谁能管用户」这类全局动作。
 *
 * 设计上刻意让**默认拒绝**成为唯一可能：`guard` 的 `need` 是必填项，
 * 新加路由时忘了声明权限会**编译不过**，而不是悄悄放行。
 * 「忘了加校验」是越权漏洞最常见的成因，靠自觉是防不住的。
 */

/** 系统级动作。新增动作必须同时在下面的角色表里归位，否则谁都做不了（fail-closed） */
export type Action =
  /** 登录即可见的信息类接口（版本号等）。存在的意义是让这类路由也必须**显式**声明 */
  | 'system:view'
  /**
   * 改系统设置（会话超时、登录锁定阈值、是否强制两步验证）。
   *
   * 与 `system:view` 分成两档：这几项一改会影响**所有人**的登录 ——
   * 把锁定阈值调到 3 次、会话超时调到 5 分钟，全站跟着变。
   * 看得见和改得了不是一回事。
   */
  | 'system:manage'
  /**
   * 看**列表**（实例列表、健康总览）。
   *
   * 与 `instance:view` 分开是必须的：列表天然没有「某一台实例」可判，
   * 而 `instance:view` 是实例级动作、缺实例即拒。合成一个会让列表接口永远 403
   * —— 这个 bug 就是被那条严格规则当场咬出来的。
   *
   * 拿到它只代表「能看到列表这个页面」，**具体哪几行仍要在处理函数里按矩阵过滤**。
   */
  | 'instance:list'
  | 'instance:view'
  | 'instance:operate'
  | 'instance:create'
  | 'instance:delete'
  | 'field:view'
  | 'replay:run'
  | 'backup:run'
  /**
   * 云对接。看状态与改参数分成两档：
   * 现场运维需要判断「是不是断了」，但接入凭据只有管理员能动 ——
   * signKey 一改，全站上行立刻验签失败。
   */
  | 'cloud:view'
  | 'cloud:manage'
  /**
   * 导诊断包 / 跑连通性探测。
   *
   * 给到运维而不是只给管理员：现场出问题时第一个到场的就是运维，
   * 让他必须找管理员才能取诊断信息，等于把 MTTR 拖长一倍。
   * 包内容已全程脱敏并有导出前自检兜底，风险可控。
   */
  | 'diag:run'
  /**
   * 流程模板。看与改分开：模板是跨实例、跨项目复用的资产，
   * 谁都可以照着已有模板了解现场做法；但删改模板会影响别人后续的套用，
   * 那是需要担责的动作。
   *
   * 注意「把模板套到某台实例上」不用这里的权限，用的是 `instance:operate`
   * —— 那是对**那台实例**的破坏性操作，必须过实例授权矩阵。
   */
  | 'template:view'
  | 'template:manage'
  /**
   * 节点管理（01 号文 5.7）。看与批分成两档，而且这一刀比模板那刀更硬：
   *
   * 批准一个节点包 = 允许它在**所有**实例里被安装并执行代码。
   * 那不是运维动作，是引入第三方代码进现场，必须落在管理员头上。
   * 运维能看清单（排障要知道装了什么），但批不了。
   */
  | 'node:view'
  | 'node:manage'
  | 'user:manage';

export type Role = 'admin' | 'operator' | 'viewer';

export const ROLES: Role[] = ['admin', 'operator', 'viewer'];

/** 实例级授权档位。`operate` 蕴含 `view` */
export type GrantLevel = 'view' | 'operate';

const ROLE_ACTIONS: Record<Role, ReadonlySet<Action>> = {
  admin: new Set<Action>([
    'system:view', 'system:manage', 'instance:list', 'instance:view', 'instance:operate', 'instance:create', 'instance:delete',
    'field:view', 'replay:run', 'backup:run', 'user:manage',
    'cloud:view', 'cloud:manage', 'diag:run', 'template:view', 'template:manage',
    'node:view', 'node:manage',
  ]),
  // 运维：管得了运行，建不了也删不了，更管不了用户
  operator: new Set<Action>([
    'system:view', 'instance:list', 'instance:view', 'instance:operate', 'field:view', 'replay:run',
    'cloud:view', 'diag:run', 'template:view', 'template:manage', 'node:view',
  ]),
  viewer: new Set<Action>([
    'system:view', 'instance:list', 'instance:view', 'field:view', 'cloud:view', 'template:view',
    'node:view',
  ]),
};

/** 未知角色一律按最小权限处理，不按 admin —— 数据脏了不该变成提权 */
export function actionsOf(role: string): ReadonlySet<Action> {
  return ROLE_ACTIONS[role as Role] ?? new Set<Action>();
}

export function can(role: string, need: Action): boolean {
  return actionsOf(role).has(need);
}

/** 该动作是否需要落到某台具体实例上 */
export function isInstanceScoped(need: Action): boolean {
  return need === 'instance:view' || need === 'instance:operate' || need === 'instance:delete';
}

/**
 * 实例级判定。
 *
 * `admin` 天然覆盖全部实例 —— 它本来就能建能删，再要求逐台授权只是给自己找麻烦。
 * 其余角色**必须有明确授权**，没有记录就是没有权限（不是「默认可见」）。
 */
export function canInstance(
  role: string,
  need: Action,
  grant: GrantLevel | undefined,
): boolean {
  if (!can(role, need)) return false;
  if (role === 'admin') return true;
  if (grant === undefined) return false;
  if (need === 'instance:view') return true;                 // view / operate 都含读
  return grant === 'operate';
}

export class AuthzError extends Error {
  readonly need: Action;
  constructor(need: Action, detail: string) {
    super(detail);
    this.name = 'AuthzError';
    this.need = need;
  }
}

/** 给前端展示用：当前角色能做什么。界面按它隐藏按钮，但**不能只靠它** —— 后端仍要判 */
export function describeRole(role: string): { role: string; actions: Action[] } {
  return { role, actions: [...actionsOf(role)].sort() };
}
