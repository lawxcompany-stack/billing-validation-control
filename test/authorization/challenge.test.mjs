import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { createAuthorizationChallenge, assertAuthorizationChallenge } from '../../src/authorization/challenge.mjs';
import { createAuthorizationManifest } from '../../src/authorization/manifest.mjs';
import { authorizationFixture } from './fixtures.mjs';

function options() {
  return { candidateSha: 'a'.repeat(40), suite: 'billing-43' };
}

function boundManifest(challenge) {
  const manifest = authorizationFixture();
  manifest.executionId = challenge.presentation.executionId;
  manifest.activationCommitment = challenge.presentation.activationCommitment;
  manifest.candidate.sha = challenge.presentation.candidateSha;
  manifest.suite = challenge.presentation.suite;
  return manifest;
}

test('production challenges expose only frozen presentation and lifecycle, never nonce or clocks', () => {
  const input = options();
  const challenge = createAuthorizationChallenge(input);
  assert.deepEqual(Reflect.ownKeys(challenge), ['presentation', 'assertUsable', 'consume', 'destroy']);
  assert.deepEqual(Reflect.ownKeys(challenge.presentation),
    ['executionId', 'activationCommitment', 'candidateSha', 'suite']);
  assert.ok(Object.isFrozen(challenge));
  assert.ok(Object.isFrozen(challenge.presentation));
  assert.match(challenge.presentation.executionId, /^[a-f0-9]{32}$/);
  assert.match(challenge.presentation.activationCommitment, /^[a-f0-9]{64}$/);
  input.candidateSha = 'b'.repeat(40);
  input.suite = 'billing-3ds-15';
  assert.equal(challenge.presentation.candidateSha, 'a'.repeat(40));
  assert.equal(challenge.presentation.suite, 'billing-43');
  assert.equal(JSON.stringify(challenge), JSON.stringify({ presentation: challenge.presentation }));
  assert.doesNotThrow(() => assertAuthorizationChallenge(challenge, boundManifest(challenge)));
  challenge.destroy();
});

test('random execution IDs and commitments are unique for independent challenges', () => {
  const challenges = Array.from({ length: 32 }, () => createAuthorizationChallenge(options()));
  assert.equal(new Set(challenges.map((c) => c.presentation.executionId)).size, 32);
  assert.equal(new Set(challenges.map((c) => c.presentation.activationCommitment)).size, 32);
  for (const challenge of challenges) challenge.destroy();
});

test('commitment matches the local-collector activation v2 domain and NUL known hash vector', (t) => {
  const randomBytes = t.mock.method(crypto, 'randomBytes', (size) => Buffer.alloc(size, 0x2a));
  syncBuiltinESMExports();
  let challenge;
  try {
    challenge = createAuthorizationChallenge(options());
    // Independently computed with OpenSSL: UTF-8 domain, one NUL, then 32 bytes of 0x2a.
    assert.equal(challenge.presentation.activationCommitment,
      'd4831826745e20ce2eb45dbb4d6fe2ee252895c379f01eb4d578a0bad8abaeb1');
  } finally {
    challenge?.destroy();
    randomBytes.mock.restore();
    syncBuiltinESMExports();
  }
});

test('copied challenge cannot authorize the same manifest', () => {
  const challenge = createAuthorizationChallenge(options());
  const manifest = boundManifest(challenge);
  for (const copy of [{ ...challenge }, JSON.parse(JSON.stringify(challenge)),
    Object.create(challenge), new Proxy(challenge, {}), true, null]) {
    assert.throws(() => assertAuthorizationChallenge(copy, manifest), { code: 'authorization_challenge_invalid' });
  }
  assert.doesNotThrow(() => assertAuthorizationChallenge(challenge, manifest));
  challenge.destroy();
});

test('caller-provided methods and presentation accessors never confer trust or execute', () => {
  let calls = 0;
  const fake = {
    get presentation() { calls++; throw new Error('untrusted'); },
    assertUsable() { calls++; }, consume() { calls++; }, destroy() { calls++; },
  };
  assert.throws(() => assertAuthorizationChallenge(fake, authorizationFixture()),
    { code: 'authorization_challenge_invalid' });
  assert.equal(calls, 0);
});

test('all four presentation bindings must match the manifest', () => {
  const challenge = createAuthorizationChallenge(options());
  for (const mutate of [
    (m) => { m.executionId = 'f'.repeat(32); },
    (m) => { m.activationCommitment = 'f'.repeat(64); },
    (m) => { m.candidate.sha = 'f'.repeat(40); },
    (m) => { m.suite = 'billing-3ds-15'; },
  ]) {
    const manifest = boundManifest(challenge);
    mutate(manifest);
    assert.throws(() => assertAuthorizationChallenge(challenge, manifest),
      { code: 'authorization_challenge_mismatch' });
  }
  assert.doesNotThrow(() => assertAuthorizationChallenge(challenge, boundManifest(challenge)));
  challenge.destroy();
});

test('collect challenges refuse schema-valid recover and recheck admission with matching bindings', () => {
  const challenge = createAuthorizationChallenge(options());
  try {
    for (const operation of ['recover', 'recheck']) {
      const manifest = createAuthorizationManifest({
        ...boundManifest(challenge), operation, sourceExecutionId: '2'.repeat(32),
      });
      assert.throws(() => assertAuthorizationChallenge(challenge, manifest),
        { code: 'authorization_operation_unsupported' });
    }
    assert.doesNotThrow(() => assertAuthorizationChallenge(challenge, boundManifest(challenge)));
  } finally {
    challenge.destroy();
  }
});

test('challenge binding refuses open or accessor manifests without executing getters', () => {
  const challenge = createAuthorizationChallenge(options());
  for (const mutate of [
    (m) => { m.extra = true; },
    (m) => { m.policy.extra = true; },
    (m) => { Object.defineProperty(m, 'executionId', { get() { throw new Error('untrusted'); } }); },
    (m) => { Object.defineProperty(m.candidate, 'sha', { get() { throw new Error('untrusted'); } }); },
  ]) {
    const manifest = boundManifest(challenge);
    mutate(manifest);
    assert.throws(() => assertAuthorizationChallenge(challenge, manifest),
      { code: 'authorization_manifest_invalid' });
  }
  challenge.destroy();
});

test('challenge construction rejects extra keys, injected nonce/time, malformed fields and accessors', () => {
  for (const input of [undefined, null, [], {}, { ...options(), candidateSha: 'A'.repeat(40) },
    { ...options(), suite: 'billing-44' }, { ...options(), nonce: Buffer.alloc(32) },
    { ...options(), now: () => 0 }, { ...options(), createdAt: 0 },
    { ...options(), executionId: 'f'.repeat(32) }, { ...options(), extra: true },
    Object.assign(Object.create(options()), {}), new Proxy(options(), {}),
    Object.defineProperty(options(), 'extra', { value: true }),
    Object.assign(options(), { [Symbol('extra')]: true }),
  ]) {
    assert.throws(() => createAuthorizationChallenge(input), {
      name: 'AuthorizationRefusal', code: 'authorization_challenge_invalid',
      message: 'authorization_challenge_invalid',
    });
  }
  let reads = 0;
  for (const key of ['candidateSha', 'suite']) {
    const input = options();
    Object.defineProperty(input, key, { get() { reads++; return options()[key]; } });
    assert.throws(() => createAuthorizationChallenge(input), { code: 'authorization_challenge_invalid' });
  }
  assert.equal(reads, 0);
});

test('consumption is one-use, binding assertions do not consume, and destroy is idempotent', () => {
  const challenge = createAuthorizationChallenge(options());
  const manifest = boundManifest(challenge);
  for (let i = 0; i < 2; i++) assert.doesNotThrow(() => assertAuthorizationChallenge(challenge, manifest));
  assert.equal(challenge.consume(), undefined);
  for (const action of [challenge.assertUsable, challenge.consume, () => assertAuthorizationChallenge(challenge, manifest)]) {
    assert.throws(action, { code: 'authorization_challenge_consumed' });
  }
  assert.doesNotThrow(challenge.destroy);
  assert.doesNotThrow(challenge.destroy);
  const destroyed = createAuthorizationChallenge(options());
  destroyed.destroy();
  assert.doesNotThrow(destroyed.destroy);
  for (const action of [destroyed.assertUsable, destroyed.consume,
    () => assertAuthorizationChallenge(destroyed, boundManifest(destroyed))]) {
    assert.throws(action, { code: 'authorization_challenge_destroyed' });
  }
});

test('expiry uses an internal monotonic 20-minute deadline, independent of wall-clock changes', (t) => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const challenge = createAuthorizationChallenge(options());
  t.mock.method(Date, 'now', () => 0);
  now = 1_200_099;
  assert.doesNotThrow(() => assertAuthorizationChallenge(challenge, boundManifest(challenge)));
  now = 1_200_100;
  assert.throws(() => challenge.assertUsable(), { code: 'authorization_challenge_expired' });
  now = 100;
  assert.throws(() => challenge.consume(), { code: 'authorization_challenge_expired' });
  challenge.destroy();
});

test('consume and binding assertions independently enforce expiry at the deadline', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const first = createAuthorizationChallenge(options());
  const second = createAuthorizationChallenge(options());
  now = 1_200_000;
  assert.throws(first.consume, { code: 'authorization_challenge_expired' });
  assert.throws(() => assertAuthorizationChallenge(second, boundManifest(second)),
    { code: 'authorization_challenge_expired' });
});

test('backward or invalid monotonic readings invalidate a challenge permanently', (t) => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  for (const invalid of [99, NaN, Infinity]) {
    now = 100;
    const challenge = createAuthorizationChallenge(options());
    now = invalid;
    assert.throws(challenge.assertUsable, { code: 'authorization_challenge_expired' });
    now = 100;
    assert.throws(challenge.consume, { code: 'authorization_challenge_expired' });
  }
});

test('public lifecycle methods reject caller clock arguments and cannot extend the deadline', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const challenge = createAuthorizationChallenge(options());
  for (const method of [challenge.assertUsable, challenge.consume, challenge.destroy]) {
    assert.throws(() => method(0), { code: 'authorization_challenge_invalid' });
  }
  now = 1_200_000;
  assert.throws(challenge.consume, { code: 'authorization_challenge_expired' });
});

test('the second supported suite has the same binding and one-use guarantees', () => {
  const challenge = createAuthorizationChallenge({ ...options(), suite: 'billing-3ds-15' });
  assert.doesNotThrow(() => assertAuthorizationChallenge(challenge, boundManifest(challenge)));
  challenge.consume();
  assert.throws(() => assertAuthorizationChallenge(challenge, boundManifest(challenge)),
    { code: 'authorization_challenge_consumed' });
});
