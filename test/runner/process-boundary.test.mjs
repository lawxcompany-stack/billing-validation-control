import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

const boundaryModule = await import('../../runner/process-boundary.mjs').catch(() => ({}));

function fakeSpawn({ stdout = '', exitCode = 0, hold = false } = {}) {
  const state = { calls: [], children: [] };
  const spawnProcess = (command, args, options) => {
    state.calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.killedWith = [];
    child.kill = (signal) => {
      child.killedWith.push(signal);
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    state.children.push(child);
    queueMicrotask(() => {
      child.emit('spawn');
      if (!hold) {
        if (stdout) child.stdout.write(stdout);
        child.stdout.end();
        child.emit('close', exitCode, null);
      }
    });
    return child;
  };
  return { state, spawnProcess };
}

test('system process boundary executes argv without a shell and returns only bounded stdout', async () => {
  assert.equal(typeof boundaryModule.createSystemProcessBoundary, 'function');
  const fake = fakeSpawn({ stdout: 'safe-result\n' });
  const boundary = boundaryModule.createSystemProcessBoundary({ spawnProcess: fake.spawnProcess,
    dockerContext: 'billing-validation-isolated' });
  const result = await boundary.run('trusted-command', ['inspect', 'one'], { env: { CONTROL_TEST: 'value' } });
  assert.equal(result.stdout, 'safe-result\n');
  assert.equal(fake.state.calls[0].options.shell, false);
  assert.equal(fake.state.calls[0].options.env.CONTROL_TEST, 'value');
});

test('system process boundary sanitizes nonzero exit and does not expose stderr text', async () => {
  assert.equal(typeof boundaryModule.createSystemProcessBoundary, 'function');
  const fake = fakeSpawn({ exitCode: 17 });
  const boundary = boundaryModule.createSystemProcessBoundary({ spawnProcess: fake.spawnProcess,
    dockerContext: 'billing-validation-isolated' });
  await assert.rejects(boundary.run('trusted-command', []), (error) => {
    assert.equal(error.code, 'process_failed');
    assert.doesNotMatch(error.message, /provider-secret-or-output/u);
    return true;
  });
});

test('system process boundary terminates an in-flight command on cancellation', async () => {
  assert.equal(typeof boundaryModule.createSystemProcessBoundary, 'function');
  const fake = fakeSpawn({ hold: true });
  const boundary = boundaryModule.createSystemProcessBoundary({ spawnProcess: fake.spawnProcess,
    dockerContext: 'billing-validation-isolated' });
  const controller = new AbortController();
  const command = boundary.run('trusted-command', [], { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(command, { code: 'process_cancelled' });
  assert.deepEqual(fake.state.children[0].killedWith, ['SIGTERM']);
});

test('system process boundary kills commands that exceed their output limit', async () => {
  assert.equal(typeof boundaryModule.createSystemProcessBoundary, 'function');
  const fake = fakeSpawn({ stdout: 'excessive-output' });
  const boundary = boundaryModule.createSystemProcessBoundary({ spawnProcess: fake.spawnProcess,
    dockerContext: 'billing-validation-isolated' });
  await assert.rejects(boundary.run('trusted-command', [], { maxOutputBytes: 3 }),
    { code: 'process_output_limit' });
  assert.ok(fake.state.children[0].killedWith.includes('SIGTERM'));
});

test('long-running process handle stops and reaps its child', async () => {
  assert.equal(typeof boundaryModule.createSystemProcessBoundary, 'function');
  const fake = fakeSpawn({ hold: true });
  const boundary = boundaryModule.createSystemProcessBoundary({ spawnProcess: fake.spawnProcess,
    dockerContext: 'billing-validation-isolated' });
  const child = await boundary.start('nested-display', [':99']);
  await child.stop();
  assert.deepEqual(fake.state.children[0].killedWith, ['SIGTERM']);
  assert.equal(child.exitCode, null);
});

test('system process boundary requires and explicitly selects only the isolated Docker context', async () => {
  assert.equal(typeof boundaryModule.createSystemProcessBoundary, 'function');
  const fake = fakeSpawn({ stdout: 'ok' });
  assert.throws(() => boundaryModule.createSystemProcessBoundary({ spawnProcess: fake.spawnProcess }),
    { code: 'process_docker_context_required' });
  assert.throws(() => boundaryModule.createSystemProcessBoundary({ spawnProcess: fake.spawnProcess,
    dockerContext: 'default' }), { code: 'process_docker_context_required' });
  const boundary = boundaryModule.createSystemProcessBoundary({ spawnProcess: fake.spawnProcess,
    dockerContext: 'billing-validation-isolated' });
  await boundary.run('docker', ['network', 'inspect', 'synthetic-network']);
  assert.deepEqual(fake.state.calls[0].args,
    ['--context', 'billing-validation-isolated', 'network', 'inspect', 'synthetic-network']);
});
