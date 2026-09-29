import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { test } from 'node:test';
import { assertAuthorizationChallenge } from '../../src/authorization/challenge.mjs';
import { serializeAuthorizationManifest } from '../../src/authorization/manifest.mjs';
import { certificateFixture } from '../runner/certificate-fixture.mjs';
import { createSystemProcessBoundary, ISOLATED_DOCKER_CONTEXT } from '../../runner/process-boundary.mjs';
import { CONTROL, WORKFLOW, NOW, verifierFixture, verifiedOutput } from './task2-fixtures.mjs';

async function optional(url) {
  return import(url).catch((error) => { if (error.code === 'ERR_MODULE_NOT_FOUND') return null; throw error; });
}
const internal = await optional('../../src/authorization/verifier-internal.mjs');
const publicModule = await optional('../../src/authorization/verifier.mjs');
const context = await optional('../../src/authorization/context.mjs');
function fixture(mutate) {
  assert.ok(internal && publicModule && context, 'Task2 verifier is not implemented');
  const f = verifierFixture(context.readAuthorizationContextWithDependencies, mutate);
  f.verify = () => internal.verifyLocalAuthorizationWithDependencies(f.input);
  return f;
}
const invalid = { code: 'authorization_attestation_invalid' };

test('synthetic boundary success invokes fixed gh verification and consumes only into an authorization receipt', async () => {
  const f = fixture();
  const receipt = await f.verify();
  assert.deepEqual(receipt, { scope: 'authorization-only',
    authorizationDigest: createHash('sha256').update(f.bytes).digest('hex'),
    executionId: f.manifest.executionId, candidateSha: 'a'.repeat(40) });
  assert.ok(Object.isFrozen(receipt));
  assert.equal(f.calls.length, 1);
  const [{ command, args, options }] = f.calls;
  assert.equal(command, 'gh');
  assert.deepEqual(args, ['attestation', 'verify', args[2],
    '--repo', CONTROL, '--signer-workflow', `${CONTROL}/${WORKFLOW}`,
    '--signer-digest', 'd'.repeat(40),
    '--cert-identity', `https://github.com/${CONTROL}/${WORKFLOW}@refs/heads/main`,
    '--cert-oidc-issuer', 'https://token.actions.githubusercontent.com',
    '--source-repo', CONTROL, '--source-ref', 'refs/heads/main', '--source-digest', 'd'.repeat(40),
    '--deny-self-hosted-runners', '--predicate-type', 'https://slsa.dev/provenance/v1', '--format', 'json']);
  assert.ok(options.timeoutMs <= 30_000);
  assert.ok(options.maxOutputBytes <= 512 * 1024);
  assert.equal(options.env.GH_CONFIG_DIR, path.join(path.dirname(args[2]), 'gh'));
  assert.equal(options.env.GH_HOST, 'github.com');
  assert.equal(options.env.GH_PROMPT_DISABLED, '1');
  assert.equal(f.contextCalls.length, 2);
  await assert.rejects(fs.stat(path.dirname(args[2])), { code: 'ENOENT' });
  assert.throws(f.challenge.assertUsable, { code: 'authorization_challenge_consumed' });
  for (const copy of [receipt, JSON.parse(JSON.stringify(receipt)), { ...f.challenge }]) {
    assert.throws(() => assertAuthorizationChallenge(copy, f.manifest), { code: 'authorization_challenge_invalid' });
  }
  await assert.rejects(f.verify(), { code: 'authorization_challenge_consumed' });
  assert.equal(f.calls.length, 1);
});

test('zero process exit with a wrong subject cannot consume the challenge', async () => {
  const f = fixture((out) => { out[0].verificationResult.statement.subject[0].name = 'billing-result.json'; });
  await assert.rejects(f.verify(), invalid);
  assert.doesNotThrow(f.challenge.assertUsable);
  await assert.rejects(fs.stat(path.dirname(f.calls[0].args[2])), { code: 'ENOENT' });
});

test('real process boundary invokes only gh without a shell or ambient credentials', async () => {
  const f = fixture(); let spawns = 0;
  f.input.boundary = createSystemProcessBoundary({ dockerContext: ISOLATED_DOCKER_CONTEXT,
    spawnProcess(command, args, options) {
      spawns++;
      assert.equal(command, 'gh');
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
      assert.equal(options.env.GH_HOST, 'github.com');
      assert.deepEqual(Object.keys(options.env).filter((key) => !['PATH', 'HOME', 'GH_CONFIG_DIR', 'GH_HOST',
        'GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'GH_NO_EXTENSION_UPDATE_NOTIFIER'].includes(key)), []);
      const child = new EventEmitter(); child.stdout = new EventEmitter();
      queueMicrotask(async () => {
        try {
          assert.deepEqual(await fs.readdir(options.env.GH_CONFIG_DIR), []);
          const bytes = await fs.readFile(args[2]);
          const out = verifiedOutput(f.manifest, createHash('sha256').update(bytes).digest('hex'));
          child.stdout.emit('data', Buffer.from(JSON.stringify(out)));
          child.emit('close', 0);
        } catch (error) { child.emit('error', error); }
      });
      return child;
    },
  });
  assert.equal((await f.verify()).scope, 'authorization-only');
  assert.equal(spawns, 1);
});

for (const field of ['issuer', 'subjectAlternativeName', 'buildSignerURI', 'buildSignerDigest',
  'sourceRepositoryURI', 'sourceRepositoryIdentifier', 'sourceRepositoryRef', 'sourceRepositoryDigest',
  'githubWorkflowTrigger', 'githubWorkflowRef', 'githubWorkflowSHA', 'runnerEnvironment', 'runInvocationURI']) {
  test(`verified certificate must bind ${field}`, async () => {
    const f = fixture((out) => { out[0].verificationResult.signature.certificate[field] = 'wrong'; });
    await assert.rejects(f.verify(), invalid);
    assert.doesNotThrow(f.challenge.assertUsable);
  });
}

for (const [name, mutate] of [
  ['digest', (out) => { out[0].verificationResult.statement.subject[0].digest.sha256 = '0'.repeat(64); }],
  ['multiple subjects', (out) => { out[0].verificationResult.statement.subject.push(out[0].verificationResult.statement.subject[0]); }],
  ['multiple attestations', (out) => { out.push(out[0]); }],
  ['wrong predicate', (out) => { out[0].verificationResult.statement.predicateType = 'https://evil.invalid'; }],
  ['absent environment', (out) => { out[0].attestation.bundle.verificationMaterial.certificate.rawBytes = certificateFixture(null); }],
  ['wrong environment', (out) => { out[0].attestation.bundle.verificationMaterial.certificate.rawBytes = certificateFixture('other'); }],
  ['environment BOM', (out) => { out[0].attestation.bundle.verificationMaterial.certificate.rawBytes = certificateFixture('\uFEFFbilling-validation-attestation'); }],
  ['summary contradicts signed environment', (out) => { out[0].verificationResult.signature.certificate.deploymentEnvironment = 'other'; }],
  ['summary cannot replace DER', (out) => {
    out[0].verificationResult.signature.certificate.deploymentEnvironment = 'billing-validation-attestation';
    out[0].attestation.bundle.verificationMaterial.certificate.rawBytes = certificateFixture(null);
  }],
  ['ambiguous certificate representations', (out) => {
    out[0].attestation.bundle.verificationMaterial.x509CertificateChain = { certificates: [{ rawBytes: certificateFixture() }] };
  }],
  ['oversized raw certificate', (out) => { out[0].attestation.bundle.verificationMaterial.certificate.rawBytes = 'a'.repeat(140_000); }],
  ['malformed DER', (out) => { out[0].attestation.bundle.verificationMaterial.certificate.rawBytes = 'AAAA'; }],
  ['missing verified timestamps', (out) => { out[0].verificationResult.verifiedTimestamps = []; }],
  ['ambiguous timestamp array', (out) => { out[0].verificationResult.verifiedTimestamps = Array(17).fill(out[0].verificationResult.verifiedTimestamps[0]); }],
  ['timestamp before signed issue', (out) => { out[0].verificationResult.verifiedTimestamps[0].timestamp = '2026-09-29T11:59:59Z'; }],
  ['timestamp after signed expiry', (out) => { out[0].verificationResult.verifiedTimestamps[0].timestamp = '2026-09-29T12:20:01Z'; }],
  ['future timestamp beyond skew', (out) => { out[0].verificationResult.verifiedTimestamps[0].timestamp = '2026-09-29T12:06:00.001Z'; }],
  ['invalid timestamp calendar', (out) => { out[0].verificationResult.verifiedTimestamps[0].timestamp = '2026-09-31T12:01:00Z'; }],
  ['untrusted timestamp URI', (out) => { out[0].verificationResult.verifiedTimestamps[0].uri = 'http://rekor.sigstore.dev'; }],
]) {
  test(`attestation refuses ${name}`, async () => {
    const f = fixture(mutate); await assert.rejects(f.verify(), invalid);
    assert.doesNotThrow(f.challenge.assertUsable);
  });
}

test('legacy X509 leaf shape and timestamp at the inclusive future-skew boundary are accepted', async () => {
  const f = fixture((out) => {
    out[0].attestation.bundle.verificationMaterial = { x509CertificateChain: { certificates: [{ rawBytes: certificateFixture() }] } };
    out[0].verificationResult.verifiedTimestamps[0].timestamp = '2026-09-29T12:06:00Z';
  });
  assert.equal((await f.verify()).scope, 'authorization-only');
});

test('submillisecond timestamps beyond future skew or signed expiry are refused without rounding', async () => {
  for (const timestamp of ['2026-09-29T12:06:00.000000001Z', '2026-09-29T12:20:00.000000001Z']) {
    const f = fixture((out) => { out[0].verificationResult.verifiedTimestamps[0].timestamp = timestamp; });
    if (timestamp.includes('12:20')) f.input.clock = () => Date.parse('2026-09-29T12:19:30Z');
    await assert.rejects(f.verify(), invalid);
    assert.doesNotThrow(f.challenge.assertUsable);
  }
});

test('at least one verified timestamp must fall in the signed interval; alternate timezone is parsed exactly', async () => {
  const f = fixture((out) => {
    const stamp = out[0].verificationResult.verifiedTimestamps[0];
    stamp.timestamp = '2026-09-29T09:01:00.123456789-03:00';
    out[0].verificationResult.verifiedTimestamps.push({ ...stamp, timestamp: '2026-09-29T11:59:00Z' });
  });
  assert.equal((await f.verify()).scope, 'authorization-only');
});

test('public API rejects all caller policy, dependency, clock and accessor injections before IO', async (t) => {
  const f = fixture(); let calls = 0;
  const unexpected = () => { calls++; throw new Error('must not execute'); };
  t.mock.method(globalThis, 'fetch', unexpected);
  const spawn = t.mock.method(childProcess, 'spawn', unexpected); syncBuiltinESMExports();
  try {
    for (const extra of ['boundary', 'processBoundary', 'get', 'readContext', 'releasePolicy', 'trustPolicy', 'clock', 'now']) {
      await assert.rejects(publicModule.verifyLocalAuthorization({ manifestBytes: f.bytes, challenge: f.challenge,
        [extra]: unexpected }), { code: 'authorization_input_invalid' });
    }
    const input = { manifestBytes: f.bytes, challenge: f.challenge };
    Object.defineProperty(input, 'signal', { get: unexpected });
    await assert.rejects(publicModule.verifyLocalAuthorization(input), { code: 'authorization_input_invalid' });
    await assert.rejects(publicModule.verifyLocalAuthorization(new Proxy(input, {})), { code: 'authorization_input_invalid' });
    assert.deepEqual(Object.keys(publicModule), ['verifyLocalAuthorization']);
    assert.equal(calls, 0);
  } finally { spawn.mock.restore(); syncBuiltinESMExports(); }
});

test('public verifier rejects extra positional inputs rather than ignoring caller dependencies', async () => {
  const f = fixture();
  await assert.rejects(publicModule.verifyLocalAuthorization({ manifestBytes: f.bytes, challenge: f.challenge }, f.input),
    { code: 'authorization_input_invalid' });
});

test('public policy file close failures remain sanitized and do not consume', async (t) => {
  const f = fixture(); const close = fsSync.closeSync;
  const mocked = t.mock.method(fsSync, 'closeSync', (fd) => { close(fd); throw new Error('/sensitive/admin/path'); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(publicModule.verifyLocalAuthorization({ manifestBytes: f.bytes, challenge: f.challenge }),
      { code: 'authorization_trust_invalid', message: 'authorization_trust_invalid' });
    assert.doesNotThrow(f.challenge.assertUsable);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('public verifier ignores ENV policy and rejects committed empty pins before subprocess or network', async (t) => {
  const f = fixture(); let calls = 0;
  const unexpected = () => { calls++; throw new Error('must not execute'); };
  t.mock.method(globalThis, 'fetch', unexpected);
  const spawn = t.mock.method(childProcess, 'spawn', unexpected); syncBuiltinESMExports();
  const keys = ['LOCAL_COLLECTOR_RELEASE_POLICY', 'LOCAL_COLLECTOR_TRUST_POLICY', 'REVIEWED_CONTROL_SHA'];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = JSON.stringify(f.input.trustPolicy);
    await assert.rejects(publicModule.verifyLocalAuthorization({ manifestBytes: f.bytes, challenge: f.challenge }),
      { code: 'authorization_control_unreviewed' });
    assert.equal(calls, 0);
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    spawn.mock.restore(); syncBuiltinESMExports();
  }
});

test('empty or mismatched control/release pins reject before external IO', async () => {
  for (const [mutate, code] of [
    [(f) => { f.input.trustPolicy.reviewedControlShas = []; }, 'authorization_control_unreviewed'],
    [(f) => { f.input.trustPolicy.reviewedControlShas = ['e'.repeat(40)]; }, 'authorization_control_unreviewed'],
    [(f) => { f.input.releasePolicy.releases = []; }, 'authorization_release_unconfigured'],
    [(f) => { f.input.releasePolicy.releases[0].suites = ['billing-3ds-15']; }, 'authorization_release_unconfigured'],
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.verify(), { code });
    assert.equal(f.calls.length + f.contextCalls.length, 0);
    assert.doesNotThrow(f.challenge.assertUsable);
  }
  for (const part of ['collectorRelease', 'policy']) {
    const f = fixture();
    for (const key of Object.keys(f.manifest[part])) {
      const original = f.input.releasePolicy.releases[0][part][key];
      f.input.releasePolicy.releases[0][part][key] = original.replace(/[a-f0-9]+$/u, (hex) => '9'.repeat(hex.length));
      await assert.rejects(f.verify(), { code: 'authorization_release_mismatch' });
      f.input.releasePolicy.releases[0][part][key] = original;
    }
    assert.equal(f.calls.length + f.contextCalls.length, 0);
  }
});

test('copied challenge, noncanonical bytes, historical operations and expired UTC refuse before IO', async () => {
  for (const [mutate, code] of [
    [(f) => { f.input.challenge = { ...f.challenge }; }, 'authorization_challenge_invalid'],
    [(f) => { f.input.manifestBytes = `${f.bytes}\n`; }, 'authorization_noncanonical'],
    [(f) => { f.input.clock = () => Date.parse(f.manifest.expiresAt); }, 'authorization_expired'],
    [(f) => { f.input.clock = () => Date.parse(f.manifest.issuedAt) - 60_001; }, 'authorization_not_yet_valid'],
    [(f) => { f.input.clock = () => NaN; }, 'authorization_expired'],
    ...['recover', 'recheck'].map((operation) => [(f) => {
      f.input.manifestBytes = serializeAuthorizationManifest({ ...f.manifest, operation, sourceExecutionId: '2'.repeat(32) });
    }, 'authorization_operation_unsupported']),
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(f.verify(), { code });
    assert.equal(f.calls.length + f.contextCalls.length, 0);
  }
});

test('mutable input, bytes and dependency slots are snapshotted before awaiting context', async () => {
  const f = fixture(); const originalRead = f.input.readContext;
  const originalBytes = Buffer.from(f.bytes);
  // The boundary checks the immutable original file, independent of the mutated caller buffer.
  f.input.boundary = { async run(command, args) {
    const { verifiedOutput } = await import('./task2-fixtures.mjs');
    assert.deepEqual(await fs.readFile(args[2]), originalBytes);
    return { stdout: JSON.stringify(verifiedOutput(f.manifest, createHash('sha256').update(originalBytes).digest('hex'))) };
  } };
  f.input.readContext = async (options) => {
    f.bytes.fill(0);
    f.input.challenge = { ...f.challenge };
    f.input.boundary.run = () => { throw new Error('replacement boundary'); };
    f.input.clock = () => NaN;
    f.input.readContext = () => { throw new Error('replacement context'); };
    f.input.releasePolicy.releases = [];
    f.input.trustPolicy.reviewedControlShas = [];
    return originalRead(options);
  };
  assert.equal((await f.verify()).scope, 'authorization-only');
  assert.throws(f.challenge.assertUsable, { code: 'authorization_challenge_consumed' });
});

test('context changed during verification refuses and leaves the challenge usable', async () => {
  const f = fixture(() => { f.api.payloads[f.api.runPath].run_attempt = 3; });
  await assert.rejects(f.verify(), { code: 'authorization_context_invalid' });
  assert.equal(f.contextCalls.length, 2);
  assert.doesNotThrow(f.challenge.assertUsable);
});

test('false or changed internal context receipts cannot be mistaken for positive evidence', async () => {
  for (const replacement of [undefined, true, {}, { controlSha: 'e'.repeat(40), runId: '567890123', runAttempt: '2' }]) {
    const f = fixture(); f.input.readContext = async () => replacement;
    await assert.rejects(f.verify(), { code: 'authorization_context_invalid' });
    assert.equal(f.calls.length, 0);
    assert.doesNotThrow(f.challenge.assertUsable);
  }
});

test('UTC expiry while awaiting gh or final context never consumes', async () => {
  for (const stage of ['gh', 'context']) {
    let now = NOW;
    const f = fixture(() => { if (stage === 'gh') now = Date.parse('2026-09-29T12:20:00Z'); });
    const read = f.input.readContext; let reads = 0;
    f.input.clock = () => now;
    f.input.readContext = async (options) => {
      const result = await read(options);
      if (++reads === 2 && stage === 'context') now = Date.parse('2026-09-29T12:20:00Z');
      return result;
    };
    await assert.rejects(f.verify(), { code: 'authorization_expired' });
    assert.doesNotThrow(f.challenge.assertUsable);
  }
});

test('timestamp future skew is rechecked if the wall clock rolls back during final context', async () => {
  const f = fixture((out) => { out[0].verificationResult.verifiedTimestamps[0].timestamp = '2026-09-29T12:01:01Z'; });
  let now = NOW; let reads = 0; const read = f.input.readContext;
  f.input.clock = () => now;
  f.input.readContext = async (options) => {
    const result = await read(options);
    if (++reads === 2) now = Date.parse('2026-09-29T12:00:00Z');
    return result;
  };
  await assert.rejects(f.verify(), invalid);
  assert.doesNotThrow(f.challenge.assertUsable);
});

test('final context also rejects main movement and changed successful job IDs', async () => {
  for (const change of ['main', 'jobs']) {
    const f = fixture(() => {
      if (change === 'main') f.api.payloads['/branches/main'].commit.sha = 'e'.repeat(40);
      else f.api.payloads[`${f.api.attemptPath}/jobs?per_page=100&page=1`].jobs[0].id++;
    });
    if (change === 'jobs') {
      // Keep IDs distinct so the final comparison, not per-read uniqueness, is tested.
      f.api.payloads[`${f.api.attemptPath}/jobs?per_page=100&page=1`].jobs[0].id = 701234560;
    }
    await assert.rejects(f.verify(), { code: 'authorization_context_invalid' });
    assert.doesNotThrow(f.challenge.assertUsable);
  }
});

test('local monotonic deadline is independently rechecked after gh', async (t) => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const f = fixture(() => { now = 1_200_000; });
  await assert.rejects(f.verify(), { code: 'authorization_challenge_expired' });
});

test('cleanup precedes final context and failure or expiry during cleanup cannot consume', async (t) => {
  const originalRm = fs.rm;
  for (const mode of ['success', 'failure', 'expiry']) {
    let now = NOW; let cleaned = false;
    const f = fixture(); f.input.clock = () => now;
    const rm = t.mock.method(fs, 'rm', async (...args) => {
      await originalRm(...args); cleaned = true;
      if (mode === 'expiry') now = Date.parse(f.manifest.expiresAt);
      if (mode === 'failure') throw new Error('private filesystem detail');
    });
    syncBuiltinESMExports();
    const read = f.input.readContext; let count = 0;
    f.input.readContext = (options) => {
      if (++count === 2) assert.equal(cleaned, true);
      return read(options);
    };
    try {
      if (mode === 'success') await f.verify();
      else {
        await assert.rejects(f.verify(), { code: mode === 'expiry' ? 'authorization_expired' : 'authorization_attestation_invalid' });
        assert.doesNotThrow(f.challenge.assertUsable);
      }
    } finally { rm.mock.restore(); syncBuiltinESMExports(); }
  }
});

test('process failure and oversized or malformed output are sanitized and never consume', async () => {
  for (const result of [new Error('secret subprocess output'), { stdout: '' }, { stdout: '{bad' },
    { stdout: ' '.repeat(524_289) }, { stdout: '[]' }, { stdout: 'true' }, {}]) {
    const f = fixture(); f.input.boundary = { async run() { if (result instanceof Error) throw result; return result; } };
    await assert.rejects(f.verify(), { name: 'AuthorizationRefusal', code: 'authorization_attestation_invalid',
      message: 'authorization_attestation_invalid' });
    assert.doesNotThrow(f.challenge.assertUsable);
  }
});

test('abort and finite deadlines reject doubles ignoring AbortSignal, without consuming', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stage of ['context', 'gh']) {
    for (const abort of [false, true]) {
      const f = fixture(); const controller = new AbortController(); f.input.signal = controller.signal;
      const hang = () => {
        queueMicrotask(() => { if (abort) controller.abort(); else t.mock.timers.tick(30_001); });
        return new Promise(() => {});
      };
      if (stage === 'context') f.input.readContext = hang; else f.input.boundary = { run: hang };
      await assert.rejects(f.verify(), { code: abort ? 'authorization_aborted' : 'authorization_timeout' });
      assert.doesNotThrow(f.challenge.assertUsable);
    }
  }
});

test('concurrent verification can consume a challenge only once', async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([f.verify(), f.verify()]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'authorization_challenge_consumed');
  assert.notEqual(f.calls[0].args[2], f.calls[1].args[2]);
});
