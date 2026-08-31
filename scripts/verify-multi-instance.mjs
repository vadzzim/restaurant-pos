#!/usr/bin/env node
// §19.10 / §22 — the multi-instance smoke run. It builds the three production images, brings up
// the infrastructure plus two addressable API replicas and one worker, and asserts that a mutation
// applied through replica A reaches a WebSocket client attached to replica B.
//
// Same shape and the same lifecycle as `verify-integration.mjs`, which it shares
// `lib/compose-run.mjs` with: bring up, run, tear down only what this run started, write to a
// file. Never a live log stream — see CLAUDE.md.
//
// The stack has its own database (`pos_multi`), so a smoke run never writes into the demo.
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

/**
 * The stack's own database, seen from the host: `docker-compose.multi.yml` hard-codes
 * `postgres:5432` for the replicas, and `postgres` publishes 5432. The migration below has to name
 * it rather than inherit `DATABASE_URL`, or a shell — or a `.env` — pointing somewhere else would
 * migrate that database instead and then leave the replicas starting against an empty schema.
 * Found by the Codex review of M14.
 *
 * `pos_multi` rather than `pos`, since M21: §19.10 applies a real mutation, so every smoke run
 * used to leave two throwaway orders on table 19 in the demo the user shows people
 * (`known-problems.md`, `[M14, P2]`). Not `pos_test` either — the integration suite truncates that
 * one between tests, and these replicas are containers that would be reading it at the time.
 */
const STACK_DATABASE = 'pos_multi';
const STACK_DATABASE_URL = `postgresql://pos:pos@localhost:5432/${STACK_DATABASE}`;

/**
 * Created here because nothing else will: the `postgres` image runs its `POSTGRES_DB` init once,
 * against a volume the user has had since M1.
 *
 * `createdb` and not a `psql -c`, and no shell plumbing around it: `run()` spawns with
 * `shell: true` so that `docker` resolves on Windows, which means a pipe or a quoted SQL string in
 * these arguments is read by **cmd.exe** rather than by the container — the first attempt ran a
 * bare `psql` inside and the `|| createdb` half on the host. Every argument here is a word.
 *
 * Already existing is the expected outcome on every run but the first, and it is the one failure
 * that is not one; anything else stops the run.
 */
const CREATE_DATABASE = ['exec', '-T', 'postgres', 'createdb', '-U', 'pos', STACK_DATABASE];
const ALREADY_EXISTS = 'already exists';

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

  const created = await runner.compose(CREATE_DATABASE, { capture: true });
  if (created.code !== 0 && !created.output.includes(ALREADY_EXISTS)) {
    return runner.finish(created.code, `could not create the ${STACK_DATABASE} database`);
  }

  const database = { env: { DATABASE_URL: STACK_DATABASE_URL } };
  const migrated = await runner.runSteps([
    ['Schema', 'pnpm', ['run', 'db:migrate'], database],
    ['Reference data', 'pnpm', ['run', 'db:seed'], database],
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
