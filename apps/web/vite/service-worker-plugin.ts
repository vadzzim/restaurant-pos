import { resolve } from 'node:path';

import { build, type Plugin } from 'vite';

/**
 * Emits `dist/sw.js` from `src/sw/service-worker.ts`.
 *
 * A second, nested build rather than a second entry in `rollupOptions.input`, because a service
 * worker has to be a **classic** script here: adding it as an app entry gives an ES module that
 * shares code-split chunks with the app, which then only registers with `{ type: 'module' }` —
 * supported in Chrome, still not everywhere, and needless for one file. `lib` mode with the `iife`
 * format produces one self-contained script at a stable, unhashed path, which is what a
 * registration URL needs.
 *
 * `apply: 'build'` keeps all of this out of dev, where registering a worker at all is wrong.
 */
export function serviceWorkerPlugin(): Plugin {
  const root = resolve(import.meta.dirname, '..');

  return {
    name: 'pos-service-worker',
    apply: 'build',

    // `closeBundle`, not `generateBundle`: the nested build writes straight into `dist/`, and
    // doing that while the parent is still assembling its own output is a race over the directory.
    async closeBundle() {
      await build({
        configFile: false,
        root,
        logLevel: 'warn',
        define: {
          // One value per build, so the worker's cache name changes and `activate` drops the
          // previous build's entries. Deriving it from the app's asset hashes would be prettier
          // and would also mean the worker could not be built without them.
          __SW_BUILD__: JSON.stringify(String(Date.now())),
        },
        build: {
          // The parent build owns `dist/`; this one adds a file to it.
          emptyOutDir: false,
          outDir: 'dist',
          lib: {
            entry: resolve(root, 'src/sw/service-worker.ts'),
            formats: ['iife'],
            name: 'posServiceWorker',
            fileName: () => 'sw.js',
          },
        },
      });
    },
  };
}
