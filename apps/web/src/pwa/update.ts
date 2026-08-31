import { ref, type Ref } from 'vue';

/**
 * The state behind the "a new version is ready" banner.
 *
 * **Why this exists instead of a `location.reload()`.** Until M23 `register.ts` reloaded the tab the
 * moment the controller was replaced: the worst failure of a demo is an interviewer reloading into
 * last week's bundle, and nothing durable is lost to a reload — the mutation queue is in Dexie and
 * the order pointer is on disk (ADR 013). But not everything on screen is durable. A cover name
 * half typed into the POS header is a `ref`, and a reload nobody asked for eats it.
 *
 * So the reload becomes the operator's, and the two costs of deferring it are paid elsewhere:
 * a page left running the old bundle can still fetch that bundle's chunks, because `activate` keeps
 * one generation of cache (`sw/service-worker.ts`), and it cannot be left running it *unknowingly*,
 * because the banner says so until it is taken.
 *
 * A module-level `ref` rather than a Pinia store, for the same reason the §18 controls are one
 * (ADR 015): there is nothing here to inject and nothing to reset between tests.
 */
const ready = ref(false);

/** Read by `components/UpdateBanner.vue`. Written only through the two functions below. */
export const updateReady: Ref<boolean> = ready;

/**
 * What to do when the service worker controlling this page changes.
 *
 * `hadController` is whether this page was already controlled when it loaded. A first-ever install
 * claims its clients — that is the point of `clientsClaim` — which fires the same event, and
 * announcing an update to a page that has just loaded the newest build is a banner that is simply
 * wrong. Only a controller being *replaced* means the bundle underneath this page changed.
 */
export function onControllerChange(hadController: boolean): void {
  if (!hadController) return;
  ready.value = true;
}

/**
 * Take the new build. Clears the flag first so that the reload — which `controllerchange` can fire
 * again during — does not leave a banner behind on the page that comes back.
 */
export function applyUpdate(): void {
  ready.value = false;
  window.location.reload();
}
