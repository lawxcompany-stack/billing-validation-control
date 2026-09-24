import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyDeploymentAttestation } from '../../src/runtime/vercel.mjs';
import { candidate, deployment, fetchFixture, policy, signedAttestation } from './fixture.mjs';

test('fetches identity only from immutable deployment origin with redirects, cache, and credentials disabled', async () => {
  const fixture = fetchFixture(signedAttestation());
  const previousTimeout = AbortSignal.timeout;
  let timeoutMs;
  AbortSignal.timeout = (milliseconds) => {
    timeoutMs = milliseconds;
    return previousTimeout(milliseconds);
  };
  try {
    const identity = await verifyDeploymentAttestation({
      deployment, candidate, policy, fetchImpl: fixture.fetchImpl, now: () => Date.now(),
    });
    assert.equal(identity.deploymentId, deployment.id);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].url, `${deployment.origin}/api/internal/deployment-identity`);
    assert.deepEqual(fixture.calls[0].options.headers, {
      Accept: 'application/json',
      'Cache-Control': 'no-store',
    });
    assert.equal(fixture.calls[0].options.redirect, 'error');
    assert.ok(fixture.calls[0].options.signal instanceof AbortSignal);
    assert.equal(timeoutMs, 30_000);
    assert.equal(Object.hasOwn(fixture.calls[0].options.headers, 'Authorization'), false);
    assert.equal(Object.hasOwn(fixture.calls[0].options.headers, 'E2E_TEST_SECRET'), false);
  } finally {
    AbortSignal.timeout = previousTimeout;
  }
});

test('rejects unsigned and bad-signature attestations', async () => {
  const valid = signedAttestation();
  const unsigned = { ...valid };
  delete unsigned.signature;
  const badSignature = { ...valid, signature: Buffer.alloc(64, 7).toString('base64') };
  for (const document of [unsigned, badSignature]) {
    await assert.rejects(verifyDeploymentAttestation({
      deployment, candidate, policy, fetchImpl: fetchFixture(document).fetchImpl,
    }), { code: 'attestation_signature_invalid' });
  }
});

test('binds deployment, origin, candidate SHA, tree, validation environment, and database project', async () => {
  const mismatches = [
    { deploymentId: 'dpl_other123' },
    { origin: 'https://lawx-zzz999yyy-team.vercel.app' },
    { commit: 'e'.repeat(40) },
    { treeHash: 'f'.repeat(40) },
    { env: 'production' },
    { projectRef: 'zyxwvutsrqponmlkjihg' },
  ];
  for (const overrides of mismatches) {
    const document = signedAttestation({ overrides });
    await assert.rejects(verifyDeploymentAttestation({
      deployment, candidate, policy, fetchImpl: fetchFixture(document).fetchImpl,
    }), { code: 'attestation_identity_mismatch' });
  }
});

test('accepts inclusive maximum-age and future-skew timestamp boundaries', async () => {
  const now = Date.parse('2026-09-23T12:00:00.000Z');
  for (const delta of [-300_000, 60_000]) {
    await verifyDeploymentAttestation({
      deployment,
      candidate,
      policy,
      now: () => now,
      fetchImpl: fetchFixture(signedAttestation({ timestamp: new Date(now + delta).toISOString() })).fetchImpl,
    });
  }
});

test('rejects expired, future, and malformed timestamps', async () => {
  const now = Date.parse('2026-09-23T12:00:00.000Z');
  for (const timestamp of [
    new Date(now - 300_001).toISOString(),
    new Date(now + 60_001).toISOString(),
    'yesterday',
  ]) {
    await assert.rejects(verifyDeploymentAttestation({
      deployment,
      candidate,
      policy,
      now: () => now,
      fetchImpl: fetchFixture(signedAttestation({ timestamp })).fetchImpl,
    }), { code: 'attestation_timestamp_invalid' });
  }
});

test('rejects redirects, failed responses, and non-immutable origins', async () => {
  const redirectFetch = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return { ok: false, status: 302, async json() { return {}; } };
  };
  await assert.rejects(verifyDeploymentAttestation({ deployment, candidate, policy, fetchImpl: redirectFetch }), {
    code: 'attestation_unavailable',
  });
  await assert.rejects(verifyDeploymentAttestation({
    deployment: { ...deployment, origin: 'https://lawx-git-preview-team.vercel.app' },
    candidate,
    policy,
    fetchImpl: async () => assert.fail('must reject before fetching'),
  }), { code: 'deployment_origin_invalid' });
});

test('rejects extra attestation fields and noncanonical signatures', async () => {
  const extraField = signedAttestation();
  extraField.unexpected = 'not allowed';
  const noncanonicalSignature = { ...signedAttestation(), signature: '***' };
  for (const document of [extraField, noncanonicalSignature]) {
    await assert.rejects(verifyDeploymentAttestation({
      deployment, candidate, policy, fetchImpl: fetchFixture(document).fetchImpl,
    }), { code: document === noncanonicalSignature ? 'attestation_signature_invalid' : 'attestation_shape_invalid' });
  }
});
