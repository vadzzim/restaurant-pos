#!/usr/bin/env node
// §19.10 / §22 — the multi-instance smoke run. It builds the three production images, brings up
// the infrastructure plus two addressable API replicas and one worker, and asserts that a mutation
// applied through replica A reaches a WebSocket client attached to replica B.
//
// Same shape and the same lifecycle as `verify-integration.mjs`, which it shares
// `lib/compose-run.mjs` with: bring up, run, tear down only what this run started, write to a
// file. Never a live log stream — see CLAUDE.md.
//
//   pnpm verify:multi          build, verify, tear down what was started
//   pnpm verify:multi --keep   leave the stack running (two replicas on :3001 and :3002,
//                              the built web on :8081 in front of both)

import { createRunner } from './lib/compose-run.mjs';

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.multi.yml'];

/** The infrastructure plus everything the overlay adds. `web-prod` is here so its image is built
 *  and actually starts; the assertion itself talks to the replicas directly. */
const SERVICES = ['postgres', 'redis', 'redpanda', 'api-1', 'api-2', 'worker-prod', 'web-prod'];

const BUILT = ['api-1', 'api-2', 'worker-prod', 'web-prod'];

const runner = createRunner({
  logName: 'multi-instance.log',
  services: SERVICES,
  composeFiles: COMPOSE_FILES,
  keep: process.argv.includes('--keep'),
});

async function main() {
  runner.write(`verify:multi — ${new Date().toISOString()}\n`);

  // Before anything is started, so the teardown can tell this run's containers from the demo
  // stack the user already had up.
  await runner.snapshot();

  // Built as its own step rather than with `up --build`, so a broken Dockerfile says so instead of
  // being reported as "the stack did not become healthy".
  runner.banner('Images');
  const built = await runner.compose(['build', ...BUILT]);
  if (built.code !== 0) {
    return runner.finish(built.code, 'the production images did not build');
  }

  // Before the replicas, not after: the images carry built output only, so migrations — which are
  // `tsx` scripts over the drizzle journal — run from the host against the published port. A
  // replica started against an empty schema would fail readiness and time out `--wait`.
  runner.banner('Infrastructure');
  const infrastructure = await runner.up({ only: ['postgres', 'redis', 'redpanda'] });
  if (infrastructure.code !== 0) {
    return runner.finish(infrastructure.code, 'the infrastructure did not become healthy');
  }

  const migrated = await runner.runSteps([
    ['Schema', 'pnpm', ['run', 'db:migrate']],
    ['Reference data', 'pnpm', ['run', 'db:seed']],
  ]);
  if (migrated.code !== 0) {
    return runner.finish(migrated.code, `${migrated.failed} failed`);
  }

  runner.banner('Two replicas, one worker');
  const up = await runner.up({ timeoutSeconds: 240 });
  if (up.code !== 0) {
    return runner.finish(up.code, 'the two-replica stack did not become healthy');
  }

  const { code, failed } = await runner.runSteps([
    ['Build packages', 'pnpm', ['run', 'build:packages']],
    [
      '§19.10 cross-instance broadcast',
      'pnpm',
      ['--filter', '@pos/api', 'run', 'test:integration'],
    ],
  ]);

  return runner.finish(
    code,
    code === 0 ? 'a mutation on replica A reached a client on replica B' : `${failed} failed`,
  );
}

await main();
