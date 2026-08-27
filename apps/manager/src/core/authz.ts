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
  | 'instance:view'
  | 'instance:operate'
  | 'instance:create'
  | 'instance:delete'
  | 'field:view'
  | 'replay:run'
  | 'backup:run'
  | 'user:manage';

export type Role = 'admin' | 'operator' | 'viewer';

export const ROLES: Role[] = ['admin', 'operator', 'viewer'];

/** 实例级授权档位。`operate` 蕴含 `view` */
export type GrantLevel = 'view' | 'operate';

const ROLE_ACTIONS: Record<Role, ReadonlySet<Action>> = {
  admin: new Set<Action>([
    'instance:view', 'instance:operate', 'instance:create', 'instance:delete',
    'field:view', 'replay:run', 'backup:run', 'user:manage',
  ]),
  // 运维：管得了运行，建不了也删不了，更管不了用户
  operator: new Set<Action>([
    'instance:view', 'instance:operate', 'field:view', 'replay:run',
  ]),
  viewer: new Set<Action>(['instance:view', 'field:view']),
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
