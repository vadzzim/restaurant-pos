import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

import { serviceWorkerPlugin } from './vite/service-worker-plugin.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), '');
  const target = env.API_PROXY_TARGET ?? 'http://localhost:3000';

  // `loadEnv` is not read-only: a `NODE_ENV` in the files it reads is promoted to
  // `process.env.VITE_USER_NODE_ENV`, and that is what Vite consults for the build's dev/prod
  // mode. The repository-root `.env` says `development` for the API's and the worker's benefit,
  // so without this line `vite build` emitted a *development* bundle — dev warnings, devtools
  // hooks, 446 kB instead of 307 kB. Found in M14 by the image, which has no `.env` and was
  // therefore the only correct production build in the repository.
  // The rule guards configuration being *read* from the environment instead of `@pos/config`.
  // This reads nothing: it clears a marker Vite wrote a line ago, in the one file that owns Vite's
  // own behaviour.
  // eslint-disable-next-line no-restricted-syntax
  delete process.env.VITE_USER_NODE_ENV;

  const proxy = {
    '/api': target,
    // Socket.IO shares the API's HTTP server, so the dev server has to proxy the upgrade too.
    '/socket.io': { target, ws: true },
  };

  return {
    plugins: [vue(), tailwindcss(), serviceWorkerPlugin()],
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      proxy,
    },
    // The service worker exists only in a production build and is never registered in dev, so
    // there is no way to exercise it on :5173. `pnpm -F @pos/web preview` serves `dist/` with the
    // same proxy, which is the one command that reproduces what nginx serves in the image.
    preview: {
      port: Number(env.WEB_PREVIEW_PORT ?? 4173),
      proxy,
    },
  };
});
