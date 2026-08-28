#!/usr/bin/env node
// The one reproducible command: bring the infrastructure up, run the suites that need it, tear
// down what this script started, and write everything to a file.
//
// It is Node rather than a shell script because the user is on Windows and CI is on Linux; one
// file that runs on both beats two that drift. It is also the only thing in this repository that
// runs `docker compose` — see CLAUDE.md.
//
//   pnpm verify:integration          bring up, verify, tear down what was started
//   pnpm verify:integration --keep   leave the containers running afterwards

import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(root, '.verify-output');
const outputFile = join(outputDir, 'integration.log');

/** Only the infrastructure. The app services sit behind the `app` profile and are not started. */
const SERVICES = ['postgres', 'redis', 'redpanda'];

const keep = process.argv.includes('--keep');

mkdirSync(outputDir, { recursive: true });
const log = createWriteStream(outputFile, { flags: 'w' });

function write(line) {
  process.stdout.write(line);
  log.write(line);
}

function banner(text) {
  write(`\n=== ${text} ===\n`);
}

/**
 * Every command's output goes to both the console and the log file, so a failure is readable
 * without re-running anything. `shell: true` is what makes `pnpm` and `docker` resolve on Windows.
 */
function run(command, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    write(`\n$ ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, { cwd: root, shell: true });
    let captured = '';

    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (capture) {
          captured += chunk;
        }
        write(chunk);
      });
    }

    child.on('error', (error) => {
      write(`\n${command} could not be started: ${error.message}\n`);
      resolve({ code: 127, output: captured });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, output: captured }));
  });
}

async function runningServices() {
  const { code, output } = await run(
    'docker',
    ['compose', 'ps', '--services', '--status', 'running'],
    {
      capture: true,
    },
  );
  if (code !== 0) {
    return [];
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => SERVICES.includes(line));
}

async function main() {
  const started = new Date().toISOString();
  write(`verify:integration — ${started}\n`);

  banner('Infrastructure');
  // The user keeps Compose up for the demo. Tearing down services this script did not start would
  // destroy that as a side effect of running the tests, so it records what was already there.
  const alreadyRunning = await runningServices();
  if (alreadyRunning.length > 0) {
    write(`already running, will be left alone: ${alreadyRunning.join(', ')}\n`);
  }

  // `--wait` blocks on the healthchecks declared in docker-compose.yml, so there is no polling
  // loop here and no sleep long enough to be wrong on a slower machine.
  const up = await run('docker', [
    'compose',
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '180',
    ...SERVICES,
  ]);
  if (up.code !== 0) {
    return finish(up.code, alreadyRunning, 'the infrastructure did not become healthy');
  }

  const steps = [
    ['Build packages', 'pnpm', ['run', 'build:packages']],
    ['API suite', 'pnpm', ['--filter', '@pos/api', 'run', 'test']],
    ['Worker suite', 'pnpm', ['--filter', '@pos/worker', 'run', 'test']],
    // The one suite that needs a live broker rather than only PostgreSQL.
    ['Broker round trip', 'pnpm', ['--filter', '@pos/worker', 'run', 'test:integration']],
  ];

  for (const [name, command, args] of steps) {
    banner(name);
    const result = await run(command, args);
    if (result.code !== 0) {
      return finish(result.code, alreadyRunning, `${name} failed`);
    }
  }

  return finish(0, alreadyRunning, 'all integration checks passed');
}

async function finish(code, alreadyRunning, summary) {
  let exitCode = code;
  let result = summary;

  if (keep) {
    banner('Teardown skipped (--keep)');
  } else {
    const toRemove = SERVICES.filter((service) => !alreadyRunning.includes(service));
    if (toRemove.length === 0) {
      banner('Teardown skipped — every service was already running before this run');
    } else {
      banner('Teardown');
      // `rm -sf`, never `down -v`: it removes only the containers this run started and never
      // touches the named volumes, so the demo database survives either way.
      const removed = await run('docker', ['compose', 'rm', '-sf', ...toRemove]);

      // The script promises to leave the machine as it found it, so a teardown that failed is a
      // failure of the run: reporting PASS would hand the next run — or CI — containers nobody
      // expects. It is summarised separately from a test failure because the cause is unrelated.
      if (removed.code !== 0) {
        write(`\ncould not remove: ${toRemove.join(', ')}\n`);
        if (exitCode === 0) {
          exitCode = removed.code;
          result = 'checks passed but teardown failed; containers may still be running';
        } else {
          result = `${result}; teardown also failed`;
        }
      }
    }
  }

  write(`\n=== RESULT: ${exitCode === 0 ? 'PASS' : 'FAIL'} — ${result} ===\n`);
  write(`full output: ${outputFile}\n`);

  await new Promise((resolve) => log.end(resolve));
  process.exit(exitCode);
}

await main();
