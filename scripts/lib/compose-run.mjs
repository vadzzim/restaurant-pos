// The Compose lifecycle the three `verify-*.mjs` scripts share: bring services up, run a list of
// steps, tear down only what this run started, and write everything to a file. These are the only
// things in the repository that run `docker compose` — see CLAUDE.md.
//
// The abstraction exists because there are now three runners with an identical lifecycle and
// different service lists. It is deliberately a runner, not a framework: the caller still owns
// its own steps and its own summary lines.
//
// `startService` and `waitForHttp` arrived with M18, which is the first run that needs the *apps*
// as well as the infrastructure: an end-to-end test has to talk to a running API, a running worker
// and a served bundle, and none of the three can be a step that finishes.

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
  function run(command, args, { capture = false, env } = {}) {
    return new Promise((resolve) => {
      write(`\n$ ${command} ${args.join(' ')}\n`);
      // `env` overrides, it does not replace: the child still needs PATH. What it sets wins over
      // the repository `.env`, because Node's `--env-file` yields to a variable already in the
      // environment — which is what lets a step name the database it means.
      const child = spawn(command, args, {
        cwd: repoRoot,
        shell: true,
        env: env === undefined ? process.env : { ...process.env, ...env },
      });
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

    // Before Compose, and regardless of `--keep`: `--keep` is about the containers a developer
    // wants to poke at, never about leaving an API holding :3000 for the next run.
    await stopServices();

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

  /**
   * Run a list of `[name, command, args, options?]` in order, stopping at the first failure.
   * The options are `run`'s, so a step can pin its own environment.
   */
  async function runSteps(steps) {
    for (const [name, command, args, options] of steps) {
      banner(name);
      const result = await run(command, args, options);
      if (result.code !== 0) {
        return { code: result.code, failed: name };
      }
    }
    return { code: 0, failed: undefined };
  }

  /** Long-lived children this run started, newest first, so `finish` can stop them all. */
  const appProcesses = [];

  /**
   * Start a long-lived process and keep it running until `finish`.
   *
   * Deliberately **without** `shell: true`, unlike `run`: these are killed rather than waited for,
   * and a shell wrapper on Windows means `kill` reaps the wrapper and leaves the real process
   * holding the port. So every caller passes an executable Node can spawn directly.
   *
   * @param {object} options
   * @param {string} options.name        prefix for this process's lines in the log
   * @param {string} options.command     an executable, not a shell builtin and not a `.cmd`
   * @param {string[]} options.args
   * @param {string} [options.cwd]       relative to the repository root
   * @param {Record<string,string>} [options.env]
   */
  function startService({ name, command, args, cwd = '.', env }) {
    write(`\n$ [${name}] ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, {
      cwd: join(repoRoot, cwd),
      env: env === undefined ? process.env : { ...process.env, ...env },
    });

    let output = '';
    const waiters = [];

    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        output += chunk;
        // Prefixed, because three services write into one file and an unattributed stack trace is
        // the hardest thing to read in it.
        write(
          chunk
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => `[${name}] ${line}\n`)
            .join(''),
        );
        for (const waiter of waiters.splice(0)) {
          waiter();
        }
      });
    }

    let exited = false;
    // Set before a deliberate kill, so a signalled exit is not read as a crash. On Windows
    // `kill` is a terminate and the code is always 1, which would make every clean run look
    // failed.
    let stopping = false;
    child.on('error', (error) => {
      exited = true;
      write(`\n[${name}] could not be started: ${error.message}\n`);
    });
    child.on('close', (code) => {
      exited = true;
      write(`\n[${name}] ${stopping ? 'stopped' : `exited with code ${code ?? 1}`}\n`);
    });

    const service = {
      name,
      get exited() {
        return exited;
      },
      /** Resolves once `pattern` has appeared in this process's output, or times out. */
      async waitForOutput(pattern, timeoutMs = 60_000) {
        const deadline = Date.now() + timeoutMs;
        while (!pattern.test(output)) {
          if (exited) {
            return false;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return false;
          }
          // Woken by the next chunk rather than by a poll interval, so a fast start is not taxed
          // and a slow one is not truncated.
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, Math.min(remaining, 250));
            waiters.push(() => {
              clearTimeout(timer);
              resolve(undefined);
            });
          });
        }
        return true;
      },
      async stop() {
        if (exited) {
          return;
        }
        stopping = true;
        child.kill();
        // A grace period, then insist: the API and the worker both drain on a signal, and on
        // Windows `kill` is already a terminate, so this second call is only ever a no-op there.
        const gaveUp = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(true), 5_000);
          child.on('close', () => {
            clearTimeout(timer);
            resolve(false);
          });
        });
        if (gaveUp) {
          child.kill('SIGKILL');
        }
      },
    };

    appProcesses.unshift(service);
    return service;
  }

  /** The processes this run started that are no longer alive — a crash, in every real case. */
  function crashedServices() {
    return appProcesses
      .filter((appProcess) => appProcess.exited)
      .map((appProcess) => appProcess.name);
  }

  async function stopServices() {
    if (appProcesses.length === 0) {
      return;
    }
    banner('Stopping app processes');
    for (const appProcess of appProcesses.splice(0)) {
      write(`stopping ${appProcess.name}\n`);
      await appProcess.stop();
    }
  }

  /**
   * Poll a URL until it answers 2xx. Used instead of a sleep for anything with an HTTP surface;
   * `--wait` covers the containers and `waitForOutput` covers a process that has none.
   *
   * `optional` is for a *probe* rather than a wait — asking whether something is already there.
   * Not answering is the expected case, so it is reported as an observation, not as a failure.
   */
  async function waitForHttp(
    url,
    { timeoutMs = 120_000, intervalMs = 500, optional = false } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    let lastProblem = 'never answered';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          write(`ready: ${url}\n`);
          return true;
        }
        lastProblem = `HTTP ${response.status}`;
      } catch (error) {
        lastProblem = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    write(
      optional
        ? `nothing answering ${url} (${lastProblem})\n`
        : `\nnot ready after ${timeoutMs} ms: ${url} — ${lastProblem}\n`,
    );
    return false;
  }

  return {
    write,
    banner,
    run,
    compose,
    snapshot,
    up,
    runSteps,
    startService,
    stopServices,
    crashedServices,
    waitForHttp,
    finish,
    outputFile,
  };
}
