import { spawn as nodeSpawn } from 'node:child_process';

export const ISOLATED_DOCKER_CONTEXT = 'billing-validation-isolated';

export class ProcessBoundaryRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProcessBoundaryRefusal';
    this.code = code;
  }
}

function validCommand(command, args) {
  return typeof command === 'string' && command.length > 0 && !command.includes('\0') &&
    Array.isArray(args) && args.every((argument) => typeof argument === 'string' && !argument.includes('\0'));
}

function childEnvironment(overrides) {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (process.env.HOME) env.HOME = process.env.HOME;
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new ProcessBoundaryRefusal('process_config_invalid');
    }
    env[key] = value;
  }
  return env;
}

export function createSystemProcessBoundary({ spawnProcess = nodeSpawn, dockerContext } = {}) {
  if (typeof spawnProcess !== 'function') throw new ProcessBoundaryRefusal('process_config_invalid');
  if (dockerContext !== ISOLATED_DOCKER_CONTEXT) {
    throw new ProcessBoundaryRefusal('process_docker_context_required');
  }

  async function run(command, args, { env, signal, timeoutMs = 30_000, maxOutputBytes = 1_048_576 } = {}) {
    if (!validCommand(command, args) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
        timeoutMs > 6 * 60 * 60 * 1000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 ||
        maxOutputBytes > 8 * 1024 * 1024) throw new ProcessBoundaryRefusal('process_config_invalid');
    if (signal?.aborted) throw new ProcessBoundaryRefusal('process_cancelled');

    return new Promise((resolve, reject) => {
      let child;
      let stdout = '';
      let outputBytes = 0;
      let settled = false;
      let timer;
      let killTimer;
      let terminationError;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value);
      };
      const terminate = (code) => {
        if (terminationError) return;
        terminationError = new ProcessBoundaryRefusal(code);
        try { child?.kill('SIGTERM'); } catch { /* child may have exited */ }
        killTimer = setTimeout(() => {
          try { child?.kill('SIGKILL'); } catch { /* child may have exited */ }
          killTimer = setTimeout(() => finish(terminationError), 1_000);
        }, 1_000);
      };
      const onAbort = () => terminate('process_cancelled');
      try {
        const effectiveArgs = command === 'docker' ? ['--context', dockerContext, ...args] : args;
        child = spawnProcess(command, effectiveArgs, { shell: false, stdio: ['ignore', 'pipe', 'ignore'],
          env: childEnvironment(env) });
      } catch {
        finish(new ProcessBoundaryRefusal('process_start_failed'));
        return;
      }
      child.stdout?.on('data', (chunk) => {
        if (terminationError) return;
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          terminate('process_output_limit');
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.once('error', () => finish(terminationError ?? new ProcessBoundaryRefusal('process_start_failed')));
      child.once('close', (code) => {
        if (terminationError) finish(terminationError);
        else if (code === 0) finish(null, Object.freeze({ stdout }));
        else finish(new ProcessBoundaryRefusal('process_failed'));
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => terminate('process_timeout'), timeoutMs);
      if (signal?.aborted) onAbort();
    });
  }

  async function start(command, args, { env } = {}) {
    if (!validCommand(command, args)) throw new ProcessBoundaryRefusal('process_config_invalid');
    let child;
    try {
      const effectiveArgs = command === 'docker' ? ['--context', dockerContext, ...args] : args;
      child = spawnProcess(command, effectiveArgs, { shell: false, stdio: 'ignore', env: childEnvironment(env) });
    } catch {
      throw new ProcessBoundaryRefusal('process_start_failed');
    }
    let exitCode = null;
    let exitSignal = null;
    const closed = new Promise((resolve) => {
      child.once('error', () => { exitCode = 1; resolve(); });
      child.once('close', (code, signal) => { exitCode = code; exitSignal = signal; resolve(); });
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new ProcessBoundaryRefusal('process_start_failed')));
    });

    return Object.freeze({
      get exitCode() { return exitCode; },
      get exitSignal() { return exitSignal; },
      async stop() {
        if (exitCode !== null) return;
        try { child.kill('SIGTERM'); } catch { /* process may have exited */ }
        let stopTimer;
        const stopped = await Promise.race([closed.then(() => true), new Promise((resolve) => {
          stopTimer = setTimeout(() => resolve(false), 2_000);
        })]);
        clearTimeout(stopTimer);
        if (!stopped) {
          try { child.kill('SIGKILL'); } catch { /* ignored */ }
          await closed;
        }
      },
    });
  }

  return Object.freeze({ run, start, dockerContext });
}
