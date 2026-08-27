import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), '');

  return {
    plugins: [vue(), tailwindcss()],
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      proxy: {
        '/api': env.API_PROXY_TARGET ?? 'http://localhost:3000',
      },
    },
  };
});
