import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { releaseFixture } from './task2-fixtures.mjs';

const api = await import('../../src/authorization/release-policy.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
function required() { assert.ok(api, 'Task2 release policy is not implemented'); return api; }

test('empty stored release policy is valid but cannot select a release', () => {
  const { validateReleasePolicy, selectRelease } = required();
  const policy = validateReleasePolicy({ schemaVersion: 1, releases: [] });
  assert.ok(Object.isFrozen(policy.releases));
  assert.throws(() => selectRelease(policy, 'billing-43'), { code: 'authorization_release_unconfigured' });
});

test('release selection snapshots every pin and is deeply immutable', () => {
  const { validateReleasePolicy, selectRelease } = required();
  const input = releaseFixture();
  const policy = validateReleasePolicy(input);
  input.releases[0].collectorRelease.sourceSha = 'f'.repeat(40);
  input.releases[0].suites.push('billing-3ds-15');
  const release = selectRelease(policy, 'billing-43');
  assert.equal(release.collectorRelease.sourceSha, '1'.repeat(40));
  for (const value of [policy, policy.releases, release, release.collectorRelease, release.policy, release.suites]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.throws(() => selectRelease(policy, 'billing-3ds-15'), { code: 'authorization_release_unconfigured' });
});

test('two matching releases are ambiguous, never selected by caller order', () => {
  const { selectRelease } = required();
  const input = releaseFixture();
  input.releases.push(structuredClone(input.releases[0]));
  assert.throws(() => selectRelease(input, 'billing-43'), { code: 'authorization_release_ambiguous' });
});

test('closed release schema rejects malformed pins, unknown suites and executable values', () => {
  const { validateReleasePolicy } = required();
  for (const mutate of [
    (p) => { p.extra = true; }, (p) => { p.schemaVersion = 2; },
    (p) => { p.releases[0].extra = true; }, (p) => { p.releases[0].collectorRelease.extra = true; },
    (p) => { p.releases[0].policy.extra = true; }, (p) => { p.releases[0].suites = []; },
    (p) => { p.releases[0].suites = ['billing-44']; },
    (p) => { p.releases[0].suites = ['billing-43', 'billing-43']; },
    (p) => { p.releases[0].collectorRelease.image = 'ghcr.io/evil/control:latest'; },
    (p) => { p.releases[0].collectorRelease.configDigest = 'f'.repeat(64); },
    (p) => { p.releases[0].collectorRelease.sourceSha = 'A'.repeat(40); },
    (p) => { p.releases[0].collectorRelease.sourceTreeSha = '0'; },
    (p) => { p.releases[0].collectorRelease.policyDigest = 'x'.repeat(64); },
    (p) => { p.releases[0].policy.limitsDigest = null; },
    (p) => { Object.defineProperty(p, 'schemaVersion', { get() { assert.fail('getter executed'); } }); },
    (p) => { Object.setPrototypeOf(p, { inherited: true }); },
    (p) => { p.releases = new Proxy(p.releases, {}); },
    (p) => { p.releases[Symbol('unknown')] = true; },
  ]) {
    const input = releaseFixture(); mutate(input);
    assert.throws(() => validateReleasePolicy(input), { code: 'authorization_release_invalid' });
  }
});

test('trust policy is a closed immutable SHA allowlist; empty is never a wildcard', () => {
  const { validateTrustPolicy } = required();
  const value = { schemaVersion: 1, reviewedControlShas: ['d'.repeat(40)] };
  const policy = validateTrustPolicy(value);
  value.reviewedControlShas[0] = 'f'.repeat(40);
  assert.deepEqual(policy.reviewedControlShas, ['d'.repeat(40)]);
  assert.ok(Object.isFrozen(policy.reviewedControlShas));
  assert.deepEqual(validateTrustPolicy({ schemaVersion: 1, reviewedControlShas: [] }).reviewedControlShas, []);
  for (const invalid of [{ schemaVersion: 1, reviewedControlShas: ['*'] },
    { schemaVersion: 1, reviewedControlShas: ['d'.repeat(40), 'd'.repeat(40)] },
    { ...policy, extra: true }, { schemaVersion: 2, reviewedControlShas: [] }]) {
    assert.throws(() => validateTrustPolicy(invalid), { code: 'authorization_trust_invalid' });
  }
});

test('committed release and trust files contain no invented pins', async () => {
  required();
  for (const [name, expected] of [['release', { schemaVersion: 1, releases: [] }],
    ['trust', { schemaVersion: 1, reviewedControlShas: [] }]]) {
    assert.deepEqual(JSON.parse(await readFile(new URL(`../../policy/local-collector-${name}.json`, import.meta.url))), expected);
  }
});
