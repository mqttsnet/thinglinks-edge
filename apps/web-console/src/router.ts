import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { api, ApiError, basePath } from './api/client';
import { can, loadPermissions } from './api/permissions';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { anon: true } },
  {
    path: '/',
    component: () => import('./layout/AppShell.vue'),
    children: [
      { path: '', redirect: '/instances' },
      { path: 'instances', name: 'instances', component: () => import('./views/InstancesView.vue') },
      { path: 'health', name: 'health', component: () => import('./views/HealthView.vue') },
      {
        path: 'field', name: 'field', component: () => import('./views/FieldView.vue'),
        meta: { need: 'field:view' },
      },
      { path: 'cloud', name: 'cloud', component: () => import('./views/CloudView.vue') },
      {
        path: 'users', name: 'users', component: () => import('./views/UsersView.vue'),
        meta: { need: 'user:manage' },
      },
      {
        path: 'backup', name: 'backup', component: () => import('./views/BackupView.vue'),
        meta: { need: 'backup:run' },
      },
      { path: 'instances/:id/logs', name: 'logs', component: () => import('./views/LogsView.vue') },
    ],
  },
];

// 路由 base 必须与 Manager 的挂载前缀一致，否则子路径部署下所有跳转都会丢前缀
export const router = createRouter({ history: createWebHistory(basePath || '/'), routes });

/** 路由守卫：未登录一律回登录页；首次登录未改密时不放行其它页面 */
router.beforeEach(async (to) => {
  if (to.meta['anon']) return true;
  try {
    const { user } = await api.me();
    if (user.mustChangePassword && to.name !== 'login') {
      return { name: 'login', query: { mustChange: '1' } };
    }
    /*
     * 权限不够的页面直接送回实例页，而不是让它渲染出来再满屏 403。
     * 这只是**导航体验**：后端每条路由仍然自己判权，绕过这里也拿不到数据。
     */
    const need = to.meta['need'];
    if (typeof need === 'string') {
      await loadPermissions();
      if (!can(need)) return { name: 'instances' };
    }
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return { name: 'login' };
    throw e;
  }
});
