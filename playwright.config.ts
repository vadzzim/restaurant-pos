import { defineConfig, devices } from '@playwright/test';

/**
 * §21's browser test. One spec, and the only one in the repository that crosses every process:
 * browser → API → outbox → publisher → Kafka → kitchen consumer → projection → WebSocket → the
 * other browser.
 *
 * Two ways in:
 *
 *   pnpm test:e2e        `scripts/verify-e2e.mjs` — Compose, migrate, seed, build, API, worker,
 *                        then this. The reproducible command, and what CI runs.
 *   pnpm test:e2e:run    this alone, against a stack the developer already has up.
 *
 * The web server is Playwright's rather than the script's: it already knows how to wait for a port
 * and how to kill a process tree on Windows, and `dist/` is the only input it needs.
 */

// The harness lives outside the apps, so `@pos/config` — which validates the *application's*
// environment and is bundled for the API, the worker and the browser — is the wrong door. These
// two variables belong to the test runner and to nothing else.
/* eslint-disable no-restricted-syntax */
const isCI = process.env.CI !== undefined && process.env.CI !== '';
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
/* eslint-enable no-restricted-syntax */

export default defineConfig({
  testDir: './e2e',

  // The stack is shared and singular: one database, one outbox publisher, one kitchen projection.
  // Parallel workers would be four browsers writing to the same aggregate table, which is a fine
  // test of something this spec is not about.
  workers: 1,
  fullyParallel: false,

  // The pipeline is asynchronous by design, so a failure is more often a timeout than an
  // assertion. A retry in CI distinguishes a cold runner from a broken one; the trace says which.
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,

  // Generous, because the first navigation in CI pays for a service-worker install and a cold
  // Kafka consumer group joining. The assertions inside carry their own, tighter budgets.
  timeout: 120_000,

  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },

  projects: [{ name: 'chromium' }],

  webServer: {
    // `preview`, never `dev`: M17 made the two different builds, and the service worker exists only
    // in the production one. This serves `dist/` behind the same proxy the image's nginx serves.
    command: 'pnpm --filter @pos/web run preview',
    // The shell itself, not a proxied API route: a health check that reaches through the proxy
    // would report "the web server failed to start" when what is actually down is the API.
    url: baseURL,
    // Locally a developer may already have the preview up; in CI nothing is listening, so starting
    // one is always right and reusing would hide a server that failed to boot.
    reuseExistingServer: !isCI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
