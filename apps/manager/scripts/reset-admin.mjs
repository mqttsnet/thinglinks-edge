/**
 * 管理员口令重置 —— 唯一的「进不去了」出口。
 *
 * 为什么需要它：初始口令只在**首次启动**时打印一次，`ensureInitialUser` 认的是
 * 「库里一个用户都没有」。所以只要库里还剩任何一个账号（哪怕是个 operator），
 * 删掉 admin 再重启也不会重建它 —— 那条路是死的。
 *
 * 这里做的事和产品自己首次启动完全一样：生成随机一次性口令、写进库、
 * 标记必须改密。**不是**绕过安全，是补上一条本来就该有的运维通道：
 * 能改这个库的人，本来就已经拿到了宿主机的文件系统权限。
 *
 * 用法（在宿主上，容器可停可不停）：
 *   node scripts/reset-admin.mjs [用户名]        # 默认 admin
 *
 * 口令只在终端打印一次，不落任何文件。改完立刻用它登录并设成自己的。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from '../dist/core/db.js';
import { hashPassword, generatePassword } from '../dist/core/auth/crypto.js';

const username = process.argv[3] ?? process.argv[2] ?? 'admin';
const dbPath = process.env['EDGE_DB']
  ?? resolve(process.env['EDGE_DATA_ROOT'] ?? '/data01/mqttsnet/thinglinks-edge', 'manager/edge.db');

if (!existsSync(dbPath)) {
  console.error(`[reset] 找不到数据库：${dbPath}`);
  console.error('[reset] 用 EDGE_DATA_ROOT 或 EDGE_DB 指到实际位置再跑一次。');
  process.exit(1);
}

const db = openDb(dbPath);
const row = db.prepare('SELECT username, role, disabled FROM app_user WHERE username = ?').get(username);
if (!row) {
  const all = db.prepare('SELECT username FROM app_user ORDER BY username').all().map((r) => r.username);
  console.error(`[reset] 库里没有账号 ${username}。现有账号：${all.join('、') || '（一个都没有）'}`);
  process.exit(1);
}

const password = generatePassword();
const { hash, salt } = hashPassword(password);
// must_change_pwd = 1：这条口令是一次性的，登录后必须换掉。
// 同时解除停用 —— 「进不去」有时正是因为账号被自己停用了
db.prepare(
  'UPDATE app_user SET pwd_hash = ?, pwd_salt = ?, must_change_pwd = 1, disabled = 0 WHERE username = ?',
).run(hash, salt, username);

console.log(`\n[reset] 已重置 ${username}（角色 ${row.role}）`);
console.log(`[reset] 一次性口令：${password}`);
console.log('[reset] 登录后会强制要求改密，改完这条即失效。');
console.log('[reset] 口令变更会作废该账号手上的旧会话，浏览器里要重新登录。\n');
