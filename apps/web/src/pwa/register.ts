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

  // Whether *this* page was already controlled when it loaded. A first-ever install claims its
  // clients (that is the point), which fires `controllerchange` — reloading on that would bounce
  // every first visit. Only a controller being *replaced* means the bundle underneath changed.
  const hadController = navigator.serviceWorker.controller !== null;
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    // One reload, guarded: `controllerchange` can fire again during the reload, and a loop here
    // is an app that never finishes loading.
    reloading = true;
    window.location.reload();
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
