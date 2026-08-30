// The Compose lifecycle that `verify-integration.mjs` and `verify-multi-instance.mjs` share:
// bring services up, run a list of steps, tear down only what this run started, and write
// everything to a file. These are the only two things in the repository that run `docker
// compose` — see CLAUDE.md.
//
// The abstraction exists because there are now two runners with an identical lifecycle and
// different service lists. It is deliberately a runner, not a framework: the caller still owns
// its own steps and its own summary lines.

import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * @param {object} options
 * @param {string} options.logName        file under `.verify-output/`
 * @param {string[]} options.services     the Compose services this run needs
 * @param {string[]} [options.composeFiles] extra `-f` files, base first
 * @param {boolean} [options.keep]        leave the containers running afterwards
 */
export function createRunner({ logName, services, composeFiles = [], keep = false }) {
  const outputDir = join(repoRoot, '.verify-output');
  const outputFile = join(outputDir, logName);

  mkdirSync(outputDir, { recursive: true });
  const log = createWriteStream(outputFile, { flags: 'w' });

  const composeArgs = composeFiles.flatMap((file) => ['-f', file]);

  function write(line) {
    process.stdout.write(line);
    log.write(line);
  }

  function banner(text) {
    write(`\n=== ${text} ===\n`);
  }

  /**
   * Every command's output goes to both the console and the log file, so a failure is readable
   * without re-running anything. `shell: true` is what makes `pnpm` and `docker` resolve on
   * Windows.
   */
  function run(command, args, { capture = false } = {}) {
    return new Promise((resolve) => {
      write(`\n$ ${command} ${args.join(' ')}\n`);
      const child = spawn(command, args, { cwd: repoRoot, shell: true });
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

  const compose = (args, options) => run('docker', ['compose', ...composeArgs, ...args], options);

  /** Which of this run's services were already up before it started. */
  async function runningServices() {
    const { code, output } = await compose(['ps', '--services', '--status', 'running'], {
      capture: true,
    });
    if (code !== 0) {
      return [];
    }
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => services.includes(line));
  }

  let alreadyRunning = [];
  let snapshotted = false;

  /**
   * The user keeps Compose up for the demo. Tearing down services this run did not start would
   * destroy that as a side effect of running the tests, so what was already there is recorded
   * before anything is started — and it has to be *before*, which is why a caller that brings some
   * services up itself has to take the snapshot first rather than leave it to `up()`.
   */
  async function snapshot() {
    if (snapshotted) {
      return alreadyRunning;
    }
    snapshotted = true;
    alreadyRunning = await runningServices();
    if (alreadyRunning.length > 0) {
      write(`already running, will be left alone: ${alreadyRunning.join(', ')}\n`);
    }
    return alreadyRunning;
  }

  /**
   * `--wait` blocks on the healthchecks declared in the Compose files, so there is no polling loop
   * here and no sleep long enough to be wrong on a slower machine.
   */
  async function up({ timeoutSeconds = 180, only = services } = {}) {
    await snapshot();
    return compose(['up', '-d', '--wait', '--wait-timeout', String(timeoutSeconds), ...only]);
  }

  async function finish(code, summary) {
    let exitCode = code;
    let result = summary;

    if (keep) {
      banner('Teardown skipped (--keep)');
    } else {
      const toRemove = services.filter((service) => !alreadyRunning.includes(service));
      if (toRemove.length === 0) {
        banner('Teardown skipped — every service was already running before this run');
      } else {
        banner('Teardown');
        // `rm -sf`, never `down -v`: it removes only the containers this run started and never
        // touches the named volumes, so the demo database survives either way.
        const removed = await compose(['rm', '-sf', ...toRemove]);

        // The runner promises to leave the machine as it found it, so a teardown that failed is a
        // failure of the run: reporting PASS would hand the next run — or CI — containers nobody
        // expects. It is summarised separately because the cause is unrelated to any test.
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

  /** Run a list of `[name, command, args]` in order, stopping at the first failure. */
  async function runSteps(steps) {
    for (const [name, command, args] of steps) {
      banner(name);
      const result = await run(command, args);
      if (result.code !== 0) {
        return { code: result.code, failed: name };
      }
    }
    return { code: 0, failed: undefined };
  }

  return { write, banner, run, compose, snapshot, up, runSteps, finish, outputFile };
}
