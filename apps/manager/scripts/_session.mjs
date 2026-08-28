/**
 * 验证脚本共用的管理员会话。
 *
 * 为什么要有这个：强制改密是**后端闸门**（`guard` 与反代都判），
 * 拿初始口令的会话调任何业务接口、开任何实例编辑器都会 403。
 * 真实用户登录后的第一步本来就是改密，脚本必须走同一条路 ——
 * 这是补上本来就该有的步骤，不是为了绕过检查。
 *
 * 用法：
 *   const s = await adminSession(B, ADMIN_PW);
 *   check('登录并完成首次改密', s.ok, `HTTP ${s.status}`);
 *   await fetch(`${B}/api/instances`, { headers: s.headers });
 */

const jarOf = (res) =>
  (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

const csrfOf = (cookie) => /tle_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';

function post(B, path, body, cookie = '', csrf = '') {
  return fetch(`${B}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * 用初始口令登录 → 改密 → 用新口令重新登录。
 *
 * 返回的 `headers` 可直接铺进 fetch，已含 cookie 与 CSRF 头。
 * 失败时 `ok` 为 false 并带上最后一步的 HTTP 状态，由调用方自己 check。
 */
export async function adminSession(B, initialPassword, newPassword = 'verify-admin-pass-01') {
  return sessionFor(B, 'admin', initialPassword, newPassword);
}

/**
 * 任意用户版。新建用户拿到的是**一次性口令**，同样带 must_change_pwd ——
 * 不走这一步，后面每条接口都会 403，而且会把「因为角色不够被拒」
 * 和「因为没改密被拒」混成同一个 403，断言就失去意义了。
 */
export async function sessionFor(B, username, initialPassword, newPassword) {
  const next = newPassword ?? `${username}-verify-pass-01`;
  const first = await post(B, '/api/login', { username, password: initialPassword });
  if (first.status !== 200) {
    return { ok: false, status: first.status, stage: 'login', cookie: '', csrf: '', headers: {} };
  }

  const c0 = jarOf(first);
  await post(B, '/api/change-password',
             { oldPassword: initialPassword, newPassword: next }, c0, csrfOf(c0));

  // 改密会清掉会话（后端主动 clearCookie），必须重新登录
  const again = await post(B, '/api/login', { username, password: next });
  const cookie = jarOf(again);
  const csrf = csrfOf(cookie);

  return {
    ok: again.status === 200 && cookie.includes('tle_sid') && Boolean(csrf),
    status: again.status,
    stage: 'relogin',
    cookie,
    csrf,
    password: next,
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
  };
}
