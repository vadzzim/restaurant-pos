import { onControllerChange } from './update';

/**
 * Registers the service worker — **in production builds only**.
 *
 * Not a stylistic guard, and please do not "simplify" it away: dev is Vite on :5173 serving every
 * module over HTTP and pushing HMR over a WebSocket. A worker that intercepts those requests makes
 * HMR lie — an edit appears to apply and the page keeps running the version the cache held. There
 * is also no `dist/sw.js` in dev; the plugin that emits it is `apply: 'build'`.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  // Whether *this* page was already controlled when it loaded. Read once, here, because after the
  // event has fired it is too late to ask. The decision it feeds is in `pwa/update.ts`, which is
  // where the test can reach it: this function returns early under vitest, since `PROD` is false.
  const hadController = navigator.serviceWorker.controller !== null;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Raises the banner; the reload is the operator's (M23, and the reasoning in `update.ts`).
    onControllerChange(hadController);
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      // Returned, not `void`ed: offline this rejects ("unknown error occurred when fetching the
      // script"), and a discarded rejection is an uncaught error in the console of exactly the
      // scenario the worker exists for. Chaining it puts it into the `catch` below.
      .then((registration) =>
        // The browser only checks for a new worker on its own schedule. A demo machine left open
        // all day would otherwise keep serving the build it woke up with.
        registration.update(),
      )
      .catch(() => {
        // Neither a failed registration nor a failed update check is a failed app: everything
        // works, the shell is just not refreshed. Swallowed rather than thrown so it cannot take
        // the page down.
      });
  });
}
