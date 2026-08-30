#!/usr/bin/env node
// The §21 end-to-end run, as one reproducible command — the same shape as `verify-integration.mjs`,
// and for the same reason: CLAUDE.md forbids streaming container logs, so the lifecycle belongs to
// a script that writes everything to a file.
//
// It is the only check in the repository that needs the *applications* running and not just the
// infrastructure, so it does more than the integration runner: migrate, seed, build, then an API
// and a worker as long-lived children. The bundle's server is Playwright's, not this script's —
// `playwright.config.ts` says why.
//
//   pnpm test:e2e            bring up, run, tear down what was started
//   pnpm test:e2e --keep     leave the containers running afterwards
//   pnpm test:e2e:run        the spec alone, against a stack you already have up
//
// Not `--headed`-friendly by design: pass extra Playwright flags to `test:e2e:run` instead.

import { createRunner } from './lib/compose-run.mjs';

/** Only the infrastructure; the `app` profile in Compose is the *dev* stack and is not used. */
const SERVICES = ['postgres', 'redis', 'redpanda'];

const API_READY_URL = 'http://localhost:3000/api/health/ready';

/**
 * How long a Kafka consumer group is given to hand out its assignment. Generous, because it is a
 * *setup* cost: a member that left without saying so holds its place until the session times out
 * (30 s by default), and two runs in a row on Windows will hit that every time.
 */
const GROUP_JOIN_TIMEOUT_MS = 120_000;

const runner = createRunner({
  logName: 'e2e.log',
  services: SERVICES,
  keep: process.argv.includes('--keep'),
});

async function main() {
  runner.write(`test:e2e — ${new Date().toISOString()}\n`);

  runner.banner('Infrastructure');
  const up = await runner.up();
  if (up.code !== 0) {
    return runner.finish(up.code, 'the infrastructure did not become healthy');
  }

  // The migration and the seed are both idempotent, so this is safe against the demo database the
  // user keeps between sessions — and necessary against a CI checkout, where the volume is new.
  //
  // So is the browser install: `pnpm install` brings in `@playwright/test` but not the Chromium it
  // drives, so without this a fresh checkout fails the one command the milestone is verified by,
  // with an error about a missing executable. Idempotent and near-free once the binary is cached.
  // It cannot replace CI's `--with-deps`, which also installs the shared libraries a bare runner
  // lacks and needs the privileges to do it; this is the half that works on a developer's machine.
  const prepared = await runner.runSteps([
    ['Chromium', 'pnpm', ['exec', 'playwright', 'install', 'chromium']],
    ['Build', 'pnpm', ['run', 'build']],
    ['Migrate', 'pnpm', ['run', 'db:migrate']],
    ['Seed', 'pnpm', ['run', 'db:seed']],
  ]);
  if (prepared.code !== 0) {
    return runner.finish(prepared.code, `${prepared.failed} failed`);
  }

  // The same courtesy `snapshot()` extends to the containers, and for the same reason: the user
  // keeps a stack up for the demo, and an API this script started would lose the bind and take the
  // run down with it — which it did, the first time this ran. A short probe, so a machine with
  // nothing on :3000 is not taxed for it.
  runner.banner('API');
  runner.write('probing :3000 for an API already up\n');
  const apiAlreadyUp = await runner.waitForHttp(API_READY_URL, {
    timeoutMs: 2_000,
    intervalMs: 250,
    optional: true,
  });

  if (apiAlreadyUp) {
    runner.write('an API is already ready on :3000 — reusing it, not starting a second\n');
  } else {
    // `node dist/index.js` and not `pnpm start`: `startService` spawns without a shell so that a
    // kill is a kill, which rules out a `.cmd` wrapper. The arguments mirror the `start` script.
    const api = runner.startService({
      name: 'api',
      command: process.execPath,
      args: ['--env-file-if-exists=../../.env', 'dist/index.js'],
      cwd: 'apps/api',
    });
    // `/api/health/ready` answers 503 until PostgreSQL, Redis and the broker all respond
    // (ADR 011), so this one poll covers the whole dependency set — no sleep anywhere below.
    if (!(await runner.waitForHttp(API_READY_URL, { timeoutMs: 90_000 }))) {
      return runner.finish(1, 'the API never became ready');
    }
    // Readiness deliberately ignores the broker, and the realtime consumer is how a canonical
    // change reaches a socket. Waiting for it here is the same trade as the worker below:
    // a group join belongs to setup, not to an assertion's budget.
    if (!(await api.waitForOutput(/realtime consumer running/, GROUP_JOIN_TIMEOUT_MS))) {
      return runner.finish(1, 'the API never joined the realtime consumer group');
    }
  }

  // The worker gets no HTTP probe because it has no HTTP surface, and it is started unconditionally
  // because a second publisher is a designed property rather than a hazard: the outbox is claimed
  // under a lease (§21.16) and the consumers share a group.
  runner.banner('Worker');
  const worker = runner.startService({
    name: 'worker',
    command: process.execPath,
    args: ['--env-file-if-exists=../../.env', 'dist/index.js'],
    cwd: 'apps/worker',
  });
  if (!(await worker.waitForOutput(/Worker started/, 60_000))) {
    return runner.finish(1, 'the worker never started');
  }
  // And then the line that actually matters. `Worker started` is liveness — the broker connection is
  // supervised behind it — and joining the `kitchen` group can take half a minute: a worker killed
  // on Windows never sends `LeaveGroup` (`kill` is a terminate there), so the *previous* run's
  // worker is still a member until its session times out, and nobody in the group consumes while a
  // rebalance is in flight. That cost is real and it is not the pipeline's, so it is paid here
  // rather than out of `PIPELINE_TIMEOUT_MS` — which is exactly what made the third trial run fail.
  if (!(await worker.waitForOutput(/broker connected/, GROUP_JOIN_TIMEOUT_MS))) {
    return runner.finish(1, 'the worker never reached the broker');
  }

  const { code, failed } = await runner.runSteps([
    ['End-to-end spec', 'pnpm', ['exec', 'playwright', 'test']],
  ]);

  // A process this script started and that died mid-run is the most likely cause of a spec that
  // timed out, and it appears nowhere in Playwright's report — so it is named in the summary
  // rather than left in the log.
  const crashed = runner.crashedServices();
  if (crashed.length > 0 && code === 0) {
    return runner.finish(1, `the spec passed but ${crashed.join(' and ')} exited during the run`);
  }

  const reused = apiAlreadyUp ? ' (against the API already running)' : '';
  const summary =
    code === 0
      ? `the end-to-end flow passed${reused}`
      : `${failed} failed${crashed.length > 0 ? ` (${crashed.join(' and ')} exited)` : ''}`;
  return runner.finish(code, summary);
}

// Every return path above goes through `runner.finish`, which stops the children before it exits.
// This is the one that does not: an unexpected throw would otherwise leave a worker running, and an
// orphaned worker holds a place in the `kitchen` consumer group — so the *next* run pays for this
// one's crash with a rebalance it cannot explain.
try {
  await main();
} catch (error) {
  runner.write(`\nthe run threw: ${error instanceof Error ? error.stack : String(error)}\n`);
  await runner.finish(1, 'the run threw before it could finish');
}
