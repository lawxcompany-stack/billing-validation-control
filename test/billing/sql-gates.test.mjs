import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIfMissing, needExport } from './support.mjs';

const sqlGates = await importIfMissing(() => import('../../src/billing/sql-gates.mjs'));

const target = Object.freeze({
  projectRef: 'abcdefghijklmnopqrst',
  parentProjectRef: 'zyxwvutsrqponmlkjihg',
  branchId: 'validation-child-123',
  branchName: 'billing-validation-child',
});

const assertionIds = [
  'checkout_rls',
  'catalog_version_audit',
  'usage_reservation_replay',
  'legacy_plan_webhook_compatibility',
  'settlement_lock_order',
  'stale_completion_renewal_fencing',
];

const raceIds = [
  'coupon_capacity',
  'checkout_payment_context_idempotency',
  'plan_change',
  'adjustment',
];

const expectedInvariants = Object.freeze({
  version: 1,
  schema: Object.freeze({
    ...target,
    schemaFingerprintSha256: 'a'.repeat(64),
    migrationHistorySha256: 'b'.repeat(64),
    triggerDigestSha256: 'c'.repeat(64),
    aclDigestSha256: 'd'.repeat(64),
    privilegeDigestSha256: 'e'.repeat(64),
  }),
  assertionDigests: Object.freeze(Object.fromEntries(assertionIds.map((id, index) =>
    [id, String(index + 1).repeat(64)]))),
  raceLoserStateDigests: Object.freeze(Object.fromEntries(raceIds.map((id, index) =>
    [id, ['7', '8', '9', 'a'][index].repeat(64)]))),
});

function installedSchema(readerId, changes = {}) {
  return {
    version: 1,
    readerId,
    ...target,
    isDefaultBranch: false,
    schemaFingerprintSha256: expectedInvariants.schema.schemaFingerprintSha256,
    migrationHistorySha256: expectedInvariants.schema.migrationHistorySha256,
    triggerDigestSha256: expectedInvariants.schema.triggerDigestSha256,
    aclDigestSha256: expectedInvariants.schema.aclDigestSha256,
    privilegeDigestSha256: expectedInvariants.schema.privilegeDigestSha256,
    ...changes,
  };
}

function concurrencyProof(readerId, barrierId, changes = {}) {
  return {
    version: 1,
    readerId,
    ...target,
    barrierId,
    assertionDigests: { ...expectedInvariants.assertionDigests },
    races: Object.fromEntries(raceIds.map((id, index) => [id, {
      committedOwnerCount: 1,
      committedOwnerDigest: String(index + 1).repeat(64),
      loserStateDigest: expectedInvariants.raceLoserStateDigests[id],
    }])),
    ...changes,
  };
}

function fakeReader(readerId, { schemaChanges = {}, proofChanges = {} } = {}) {
  const calls = [];
  return {
    calls,
    reader: {
      trustedReaderId: readerId,
      identity: { projectRef: target.projectRef, branchId: target.branchId, readOnly: true },
      async readInstalledSchemaState(input) {
        calls.push({ method: 'schema', input });
        return installedSchema(readerId, schemaChanges);
      },
      async readConcurrencyProof(input) {
        calls.push({ method: 'barrier', input });
        return concurrencyProof(readerId, input.barrierId, proofChanges);
      },
    },
  };
}

function validGateInput(overrides = {}) {
  const schema = fakeReader('schema-reader-1');
  const barrierA = fakeReader('concurrency-reader-a');
  const barrierB = fakeReader('concurrency-reader-b');
  return {
    input: {
      expectedInvariants,
      schemaReader: schema.reader,
      concurrencyReaders: [barrierA.reader, barrierB.reader],
      ...overrides,
    },
    schema,
    barrierA,
    barrierB,
  };
}

test('refuses a caller-chosen fixture target unless the protected validation policy binds it', async () => {
  const verify = needExport(sqlGates, 'verifyTrustedBillingSqlGates');
  const fixture = validGateInput();

  await assert.rejects(verify(fixture.input), { code: 'sql_gate_protected_target_mismatch' });

  assert.equal(fixture.schema.calls.length, 0);
  assert.equal(fixture.barrierA.calls.length, 0);
  assert.equal(fixture.barrierB.calls.length, 0);

  const alternate = validGateInput({ policy: { environment: 'billing-validation', database: target } });
  await assert.rejects(verify(alternate.input), { code: 'sql_gate_input_invalid' });
  assert.equal(alternate.schema.calls.length, 0);
  assert.equal(alternate.barrierA.calls.length, 0);
  assert.equal(alternate.barrierB.calls.length, 0);
});

test('fails closed because the protected child-policy pins are incomplete', async () => {
  const verify = needExport(sqlGates, 'verifyTrustedBillingSqlGates');
  const fixture = validGateInput();
  const protectedPolicy = JSON.parse(await (await import('node:fs/promises')).readFile(
    new URL('../../policy/environment-policy.json', import.meta.url), 'utf8'));
  fixture.input.expectedInvariants = {
    ...expectedInvariants,
    schema: {
      ...expectedInvariants.schema,
      projectRef: protectedPolicy.database.projectRef,
      branchId: protectedPolicy.database.branchId,
      branchName: protectedPolicy.database.branchName,
    },
  };

  await assert.rejects(verify(fixture.input), { code: 'sql_gate_protected_policy_unconfigured' });

  assert.equal(fixture.schema.calls.length, 0);
  assert.equal(fixture.barrierA.calls.length, 0);
  assert.equal(fixture.barrierB.calls.length, 0);
});

test('refuses missing migration or fingerprint pins before reading the installed schema', async () => {
  const verify = needExport(sqlGates, 'verifyInstalledSchemaEvidence');
  for (const key of ['migrationHistorySha256', 'schemaFingerprintSha256']) {
    const fixture = validGateInput();
    const schema = { ...expectedInvariants.schema };
    delete schema[key];
    const expected = { ...expectedInvariants, schema };
    await assert.rejects(verify(expected, fixture.schema.reader), { code: 'sql_gate_expected_invariants_invalid' });
    assert.equal(fixture.schema.calls.length, 0);
  }
});

test('refuses parent/child branch mismatch, disallowed main, and installed trigger, ACL, or privilege drift', async () => {
  const verify = needExport(sqlGates, 'verifyInstalledSchemaEvidence');
  for (const changes of [
    { parentProjectRef: target.projectRef },
    { branchId: 'wrong-validation-branch' },
    { branchName: 'other-validation-branch' },
    { branchId: 'main' },
    { branchName: 'production' },
    { isDefaultBranch: true },
    { triggerDigestSha256: 'f'.repeat(64) },
    { aclDigestSha256: 'f'.repeat(64) },
    { privilegeDigestSha256: 'f'.repeat(64) },
    { migrationHistorySha256: undefined },
    { schemaFingerprintSha256: undefined },
  ]) {
    const fixture = validGateInput();
    fixture.schema.reader.readInstalledSchemaState = async (input) => {
      fixture.schema.calls.push({ method: 'schema', input });
      return installedSchema('schema-reader-1', changes);
    };
    const code = ['migrationHistorySha256', 'schemaFingerprintSha256'].some((key) =>
      Object.hasOwn(changes, key) && changes[key] === undefined)
      ? 'sql_gate_schema_proof_invalid' : 'sql_gate_schema_mismatch';
    await assert.rejects(verify(expectedInvariants, fixture.schema.reader), { code });
    assert.equal(fixture.schema.calls.length, 1);
  }
});

test('refuses requests to apply candidate SQL without calling any reader', async () => {
  const verify = needExport(sqlGates, 'verifyTrustedBillingSqlGates');
  const fixture = validGateInput({ applyCandidateSql: true });

  await assert.rejects(verify(fixture.input), { code: 'sql_gate_input_invalid' });

  assert.equal(fixture.schema.calls.length, 0);
  assert.equal(fixture.barrierA.calls.length, 0);
  assert.equal(fixture.barrierB.calls.length, 0);
});

test('pins the versioned expectations before awaiting installed-schema evidence', async () => {
  const verifySchemaEvidence = needExport(sqlGates, 'verifyInstalledSchemaEvidence');
  const fixture = validGateInput();
  const mutableExpected = structuredClone(expectedInvariants);
  let markReadStarted;
  let releaseRead;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readReleased = new Promise((resolve) => { releaseRead = resolve; });
  fixture.schema.reader.readInstalledSchemaState = async () => {
    markReadStarted();
    await readReleased;
    return installedSchema('schema-reader-1', { schemaFingerprintSha256: 'f'.repeat(64) });
  };

  const verification = verifySchemaEvidence(mutableExpected, fixture.schema.reader);
  await readStarted;
  mutableExpected.schema.schemaFingerprintSha256 = 'f'.repeat(64);
  releaseRead();

  await assert.rejects(verification, { code: 'sql_gate_schema_mismatch' });
});

test('requires one committed owner and the exact pinned loser state at both barriers', async () => {
  const verify = needExport(sqlGates, 'verifyConcurrencyEvidence');
  for (const { proofChanges, code } of [
    {
      proofChanges: { races: { ...concurrencyProof('concurrency-reader-a', 'billing-sql-barrier-a').races,
        coupon_capacity: { committedOwnerCount: 2, committedOwnerDigest: '1'.repeat(64),
          loserStateDigest: expectedInvariants.raceLoserStateDigests.coupon_capacity } } },
      code: 'sql_gate_concurrency_proof_invalid',
    },
    {
      proofChanges: { races: { ...concurrencyProof('concurrency-reader-a', 'billing-sql-barrier-a').races,
        adjustment: { committedOwnerCount: 1, committedOwnerDigest: '1'.repeat(64),
          loserStateDigest: 'f'.repeat(64) } } },
      code: 'sql_gate_race_mismatch',
    },
  ]) {
    const fixture = validGateInput();
    fixture.barrierA.reader.readConcurrencyProof = async (input) => {
      fixture.barrierA.calls.push({ method: 'barrier', input });
      return concurrencyProof('concurrency-reader-a', input.barrierId, proofChanges);
    };
    await assert.rejects(verify(expectedInvariants,
      [fixture.barrierA.reader, fixture.barrierB.reader]), { code });
    assert.equal(fixture.barrierA.calls.length, 1);
    assert.equal(fixture.barrierB.calls.length, 1);
    assert.equal(fixture.barrierA.calls[0].input.barrierId, 'billing-sql-barrier-a');
    assert.equal(fixture.barrierB.calls[0].input.barrierId, 'billing-sql-barrier-b');
  }
});

test('requires all six dedicated assertions and two distinct read-only backend readers', async () => {
  const verify = needExport(sqlGates, 'verifyConcurrencyEvidence');
  const valid = validGateInput();
  const result = await verify(expectedInvariants, [valid.barrierA.reader, valid.barrierB.reader]);
  assert.equal(result, undefined);
  assert.equal(valid.barrierA.calls.length, 1);
  assert.equal(valid.barrierB.calls.length, 1);
  assert.deepEqual(valid.barrierA.calls.map(({ input }) => input.barrierId), ['billing-sql-barrier-a']);
  assert.deepEqual(valid.barrierB.calls.map(({ input }) => input.barrierId), ['billing-sql-barrier-b']);

  const duplicateReaders = validGateInput();
  duplicateReaders.barrierB.reader.trustedReaderId = duplicateReaders.barrierA.reader.trustedReaderId;
  await assert.rejects(verify(expectedInvariants,
    [duplicateReaders.barrierA.reader, duplicateReaders.barrierB.reader]),
  { code: 'sql_gate_readers_not_independent' });
  assert.equal(duplicateReaders.barrierA.calls.length, 0);
  assert.equal(duplicateReaders.barrierB.calls.length, 0);

  const missingAssertion = validGateInput();
  const evidence = concurrencyProof('concurrency-reader-a', 'billing-sql-barrier-a');
  delete evidence.assertionDigests.legacy_plan_webhook_compatibility;
  missingAssertion.barrierA.reader.readConcurrencyProof = async (input) => {
    missingAssertion.barrierA.calls.push({ method: 'barrier', input });
    return evidence;
  };
  await assert.rejects(verify(expectedInvariants,
    [missingAssertion.barrierA.reader, missingAssertion.barrierB.reader]),
  { code: 'sql_gate_concurrency_proof_invalid' });
  assert.equal(missingAssertion.barrierA.calls.length, 1);
  assert.equal(missingAssertion.barrierB.calls.length, 1);

  const mismatchedAssertion = validGateInput();
  mismatchedAssertion.barrierA.reader.readConcurrencyProof = async (input) => {
    mismatchedAssertion.barrierA.calls.push({ method: 'barrier', input });
    return concurrencyProof('concurrency-reader-a', input.barrierId, {
      assertionDigests: { ...expectedInvariants.assertionDigests, checkout_rls: 'f'.repeat(64) },
    });
  };
  await assert.rejects(verify(expectedInvariants,
    [mismatchedAssertion.barrierA.reader, mismatchedAssertion.barrierB.reader]),
  { code: 'sql_gate_assertion_mismatch' });
  assert.equal(mismatchedAssertion.barrierA.calls.length, 1);
  assert.equal(mismatchedAssertion.barrierB.calls.length, 1);

  const noReadOnlyProof = validGateInput();
  noReadOnlyProof.barrierB.reader.identity.readOnly = false;
  await assert.rejects(verify(expectedInvariants,
    [noReadOnlyProof.barrierA.reader, noReadOnlyProof.barrierB.reader]),
  { code: 'sql_gate_reader_unavailable' });
  assert.equal(noReadOnlyProof.barrierA.calls.length, 0);
  assert.equal(noReadOnlyProof.barrierB.calls.length, 0);
});
