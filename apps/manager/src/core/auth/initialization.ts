import { AuthError, type AuthService } from './service.ts';

export function initializeAdministrator(auth: AuthService, env: NodeJS.ProcessEnv = process.env) {
  const mode = (env['ADMIN_SETUP_MODE'] ?? 'browser').trim();
  if (mode !== 'password' && mode !== 'browser') throw new AuthError('ADMIN_SETUP_MODE 必须为 password 或 browser');
  if (!auth.needsSetup()) return 'existing';
  const password = env['INITIAL_PASSWORD']?.trim() || env['COMPOSE_INITIAL_PASSWORD'];
  if (mode === 'password') {
    if (!password) throw new AuthError('首次部署需要初始管理员密码：请填写 Compose 顶部的初始密码后重新启动');
    auth.createFirstAdmin('admin', password);
    return 'configured';
  }
  if (password) {
    auth.ensureInitialUser('admin', password);
    return 'initial';
  }
  return 'browser';
}
