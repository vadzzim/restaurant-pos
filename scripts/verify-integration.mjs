#!/usr/bin/env node
// The one reproducible command: bring the infrastructure up, run the suites that need it, tear
// down what this script started, and write everything to a file.
//
// It is Node rather than a shell script because the user is on Windows and CI is on Linux; one
// file that runs on both beats two that drift. The Compose lifecycle lives in
// `lib/compose-run.mjs`, shared with `verify-multi-instance.mjs`.
//
//   pnpm verify:integration          bring up, verify, tear down what was started
//   pnpm verify:integration --keep   leave the containers running afterwards

import { createRunner } from './lib/compose-run.mjs';

/** Only the infrastructure. The app services sit behind the `app` profile and are not started. */
const SERVICES = ['postgres', 'redis', 'redpanda'];

const runner = createRunner({
  logName: 'integration.log',
  services: SERVICES,
  keep: process.argv.includes('--keep'),
});

async function main() {
  runner.write(`verify:integration — ${new Date().toISOString()}\n`);

  runner.banner('Infrastructure');
  const up = await runner.up();
  if (up.code !== 0) {
    return runner.finish(up.code, 'the infrastructure did not become healthy');
  }

  const { code, failed } = await runner.runSteps([
    ['Build packages', 'pnpm', ['run', 'build:packages']],
    ['API suite', 'pnpm', ['--filter', '@pos/api', 'run', 'test']],
    ['Worker suite', 'pnpm', ['--filter', '@pos/worker', 'run', 'test']],
    // The suites that need a live broker or a live Redis rather than only PostgreSQL.
    [
      'Broker and queue round trips',
      'pnpm',
      ['--filter', '@pos/worker', 'run', 'test:integration'],
    ],
  ]);

  return runner.finish(code, code === 0 ? 'all integration checks passed' : `${failed} failed`);
}

await main();
