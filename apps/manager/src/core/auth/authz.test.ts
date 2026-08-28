import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, canInstance, actionsOf, isInstanceScoped, describeRole, ROLES, type Action } from './authz.ts';

test('三个角色的能力边界', () => {
  assert.ok(can('admin', 'user:manage'));
  assert.ok(can('admin', 'instance:delete'));

  assert.ok(can('operator', 'instance:operate'), '运维要能启停');
  assert.ok(!can('operator', 'instance:create'), '运维不能建实例');
  assert.ok(!can('operator', 'instance:delete'), '运维不能删实例');
  assert.ok(!can('operator', 'user:manage'), '运维不能管用户');
  assert.ok(!can('operator', 'backup:run'), '备份含全部实例凭据，不给运维');

  assert.ok(can('viewer', 'instance:view'));
  assert.ok(!can('viewer', 'instance:operate'), '只读就是只读');
  assert.ok(!can('viewer', 'replay:run'));
});

test('未知角色按最小权限，不按 admin', () => {
  // 库里角色字段脏了不该变成提权
  for (const bogus of ['', 'root', 'superuser', 'ADMIN', 'undefined']) {
    assert.equal(actionsOf(bogus).size, 0, `角色 ${JSON.stringify(bogus)} 不该有任何权限`);
    assert.ok(!can(bogus, 'instance:view'));
  }
});

test('实例矩阵：没有授权记录就是没有权限', () => {
  assert.ok(!canInstance('operator', 'instance:view', undefined), '未授权的实例不可见');
  assert.ok(!canInstance('viewer', 'instance:view', undefined));
});

test('实例矩阵：operate 蕴含 view，view 不蕴含 operate', () => {
  assert.ok(canInstance('operator', 'instance:view', 'view'));
  assert.ok(canInstance('operator', 'instance:view', 'operate'));
  assert.ok(canInstance('operator', 'instance:operate', 'operate'));
  assert.ok(!canInstance('operator', 'instance:operate', 'view'), 'view 档不能启停');
});

test('admin 覆盖全部实例，不需要逐台授权', () => {
  assert.ok(canInstance('admin', 'instance:operate', undefined));
  assert.ok(canInstance('admin', 'instance:delete', undefined));
});

test('角色不够时，实例授权再高也没用', () => {
  // 授权矩阵是收窄，不是提权 —— 给 viewer 发 operate 也不能启停
  assert.ok(!canInstance('viewer', 'instance:operate', 'operate'));
  assert.ok(!canInstance('operator', 'instance:delete', 'operate'), '删实例是角色级动作');
});

test('哪些动作需要落到具体实例', () => {
  assert.ok(isInstanceScoped('instance:view'));
  assert.ok(isInstanceScoped('instance:operate'));
  assert.ok(isInstanceScoped('instance:delete'));
  assert.ok(!isInstanceScoped('instance:create'), '建实例时还没有实例可授权');
  assert.ok(!isInstanceScoped('user:manage'));
  assert.ok(!isInstanceScoped('backup:run'));
});

test('每个动作至少归属一个角色 —— 否则谁都做不了', () => {
  /*
   * 写成 Record<Action, true> 而不是数组：新增一个动作却忘了加进来会**编译不过**，
   * 数组则只会让这条断言悄悄少覆盖一个动作 —— 而那正是「谁都做不了」的漏网方式。
   */
  const ALL: Record<Action, true> = {
    'system:view': true, 'instance:list': true, 'instance:view': true, 'instance:operate': true,
    'instance:create': true, 'instance:delete': true, 'field:view': true, 'replay:run': true,
    'backup:run': true, 'cloud:view': true, 'cloud:manage': true, 'diag:run': true,
    'template:view': true, 'template:manage': true, 'user:manage': true,
  };
  for (const a of Object.keys(ALL) as Action[]) {
    assert.ok(ROLES.some((r) => can(r, a)), `动作 ${a} 没有任何角色能做`);
  }
});

test('describeRole 给前端用，但只是展示', () => {
  const d = describeRole('viewer');
  assert.equal(d.role, 'viewer');
  assert.deepEqual(d.actions,
    ['cloud:view', 'field:view', 'instance:list', 'instance:view', 'system:view', 'template:view']);
  assert.deepEqual(describeRole('nobody').actions, []);
});

test('列表动作不是实例级 —— 否则列表接口永远 403', () => {
  // 列表天然没有「某一台实例」可判。这条曾经真的把列表接口锁死过
  assert.ok(!isInstanceScoped('instance:list'));
  assert.ok(can('viewer', 'instance:list'));
  assert.ok(can('operator', 'instance:list'));
});
