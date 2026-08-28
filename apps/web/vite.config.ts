import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), '');
  const target = env.API_PROXY_TARGET ?? 'http://localhost:3000';

  return {
    plugins: [vue(), tailwindcss()],
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      proxy: {
        '/api': target,
        // Socket.IO shares the API's HTTP server, so the dev server has to proxy the upgrade too.
        '/socket.io': { target, ws: true },
      },
    },
  };
});
