# Recorded demo

The canonical short demo is the GitHub-hosted
[H.264 MP4](https://github.com/user-attachments/assets/58af79db-5a92-4409-9f6c-73a1e40c456b).
It is generated from a Playwright test against the production web bundle and real PostgreSQL,
Redis, and Redpanda services. The captions are rendered into the browser viewport, so narration is
not required. Hosting the published binary outside Git keeps regenerated video out of repository
history.

## Record it

Requirements are the same as `pnpm test:e2e`: Node.js 24+, pnpm 10+, Docker with Compose, and enough
free ports for the local stack. The recording command installs Playwright's Chromium if needed.

```bash
pnpm install
pnpm demo:record
```

The command owns the lifecycle: infrastructure, migrations, seed, production build, API, worker,
browser recording, and cleanup. It writes the final asset to
`.verify-output/restaurant-pos-demo.webm` and a full run log to
`.verify-output/demo-recording.log`. It does not stop containers that were already running.

The 88-second path is deterministic:

1. Create an order, add a product, and send it from POS to the kitchen projection through the
   transactional outbox and Redpanda.
2. Simulate an offline terminal, queue three mutations in IndexedDB, reconnect, and watch the FIFO
   queue drain.
3. Arm a competing write, hit the optimistic version conflict, and show the blocked tail plus the
   explicit Rebase recovery.
4. Pause the outbox publisher, accept another order while the broker path is unavailable, inspect
   the durable backlog, resume the worker, and see the kitchen recover.

The ordinary `pnpm test:e2e` remains the smaller acceptance test and does not run or overwrite the
recording. The recording behavior lives in [`e2e/demo.spec.ts`](../e2e/demo.spec.ts). All generated
media under `.verify-output` is ignored by Git.

## Publish it

GitHub recommends H.264 for browser compatibility. If `ffmpeg` is installed, convert the local
Playwright WebM before uploading it as a GitHub attachment:

```bash
ffmpeg -i .verify-output/restaurant-pos-demo.webm -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart -an .verify-output/restaurant-pos-demo.mp4
```
