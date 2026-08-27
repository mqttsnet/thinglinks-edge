import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // 开发态把 API 与实例反代都转给 Manager，避免跨域与 Cookie 问题
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/red': { target: 'http://127.0.0.1:8080', changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
