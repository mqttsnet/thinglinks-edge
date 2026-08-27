import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { api, ApiError, basePath } from './api/client';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { anon: true } },
  {
    path: '/',
    component: () => import('./layout/AppShell.vue'),
    children: [
      { path: '', redirect: '/instances' },
      { path: 'instances', name: 'instances', component: () => import('./views/InstancesView.vue') },
      { path: 'health', name: 'health', component: () => import('./views/HealthView.vue') },
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
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return { name: 'login' };
    throw e;
  }
});
