import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID } from '../../src/contracts/control-identity.mjs';
import {
  createAuthorizationManifest,
  serializeAuthorizationManifest,
  parseAuthorizationManifest,
  authorizationDigest,
} from '../../src/authorization/manifest.mjs';
import { authorizationFixture } from './fixtures.mjs';

// Independently spelled bytes lock the signing contract, including every key order and LF.
const EXPECTED = '{"schemaVersion":2,"kind":"billing-collector-authorization","executionMode":"isolated-local","operation":"collect",'
  + '"executionId":"11111111111111111111111111111111","activationCommitment":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",'
  + '"candidate":{"repository":"lawxcompany-stack/Plataforma-LawX","repositoryId":"1234079266","pullNumber":"123","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","treeSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","baseSha":"cccccccccccccccccccccccccccccccccccccccc"},'
  + '"prerequisites":{"workflowId":"290018021","workflowPath":".github/workflows/ci.yml","runId":"345678901","runAttempt":"1","jobs":[{"key":"quality","jobId":"456789012","conclusion":"success"},{"key":"regression","jobId":"456789013","conclusion":"success"},{"key":"build","jobId":"456789014","conclusion":"success"}]},'
  + '"control":{"repository":"lawx-ai/billing-validation-control","repositoryId":"1384018279","ref":"refs/heads/main","workflowPath":".github/workflows/authorize-local-collector.yml","sha":"dddddddddddddddddddddddddddddddddddddddd","runId":"567890123","runAttempt":"2","event":"workflow_dispatch"},'
  + '"collectorRelease":{"image":"ghcr.io/lawxcompany-stack/billing-validation-control@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","configDigest":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","sourceSha":"1111111111111111111111111111111111111111","sourceTreeSha":"2222222222222222222222222222222222222222","policyDigest":"3333333333333333333333333333333333333333333333333333333333333333"},'
  + '"policy":{"environmentDigest":"4444444444444444444444444444444444444444444444444444444444444444","contractsDigest":"5555555555555555555555555555555555555555555555555555555555555555","egressDigest":"6666666666666666666666666666666666666666666666666666666666666666","limitsDigest":"7777777777777777777777777777777777777777777777777777777777777777"},'
  + '"suite":"billing-43","issuedAt":"2026-09-29T12:00:00.000Z","expiresAt":"2026-09-29T12:20:00.000Z","sourceExecutionId":null}\n';

function setField(value, path, replacement) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((parent, key) => parent[key], value)[last] = replacement;
}

function assertInvalid(value) {
  assert.throws(() => createAuthorizationManifest(value), {
    name: 'AuthorizationRefusal', code: 'authorization_manifest_invalid',
    message: 'authorization_manifest_invalid',
  });
}

test('control identity migrates while candidate identity and the legacy image pin stay unchanged', () => {
  const manifest = createAuthorizationManifest(authorizationFixture());
  assert.equal(manifest.control.repository, CONTROL_REPOSITORY);
  assert.equal(manifest.control.repositoryId, CONTROL_REPOSITORY_ID);
  assert.equal(manifest.candidate.repository, 'lawxcompany-stack/Plataforma-LawX');
  assert.equal(manifest.candidate.repositoryId, '1234079266');
  assert.match(manifest.collectorRelease.image,
    /^ghcr\.io\/lawxcompany-stack\/billing-validation-control@sha256:[a-f0-9]{64}$/u);
  assert.equal(manifest.collectorRelease.image,
    'ghcr.io/lawxcompany-stack/billing-validation-control@sha256:' + 'e'.repeat(64));
});

test('old-owner control manifest is rejected by construction, parsing and hashing', () => {
  const old = authorizationFixture();
  old.control.repository = 'lawxcompany-stack/billing-validation-control';
  assertInvalid(old);
  const bytes = EXPECTED.replace('"control":{"repository":"lawx-ai/billing-validation-control"',
    '"control":{"repository":"lawxcompany-stack/billing-validation-control"');
  assert.throws(() => parseAuthorizationManifest(bytes), { code: 'authorization_noncanonical' });
  assert.throws(() => authorizationDigest(bytes), { code: 'authorization_noncanonical' });
});

test('canonical bytes have the exact closed field order independent of input insertion order', () => {
  const input = authorizationFixture();
  input.candidate = Object.fromEntries(Object.entries(input.candidate).reverse());
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(serializeAuthorizationManifest(reversed), EXPECTED);
  for (const bytes of [EXPECTED, Buffer.from(EXPECTED), new Uint8Array(Buffer.from(EXPECTED))]) {
    assert.deepEqual(parseAuthorizationManifest(bytes), authorizationFixture());
  }
});

test('fixtures are fresh and manifests are deeply frozen detached snapshots', () => {
  const input = authorizationFixture();
  const manifest = createAuthorizationManifest(input);
  function checkFrozen(value) {
    if (value && typeof value === 'object') {
      assert.ok(Object.isFrozen(value));
      for (const child of Object.values(value)) checkFrozen(child);
    }
  }
  checkFrozen(manifest);
  checkFrozen(parseAuthorizationManifest(EXPECTED));
  input.candidate.sha = 'f'.repeat(40);
  input.prerequisites.jobs[0].jobId = '999';
  input.policy.egressDigest = 'f'.repeat(64);
  assert.equal(serializeAuthorizationManifest(manifest), EXPECTED);
  assert.equal(serializeAuthorizationManifest(authorizationFixture()), EXPECTED);
  assert.throws(() => { manifest.prerequisites.jobs[0].jobId = '888'; }, TypeError);
  assert.throws(() => manifest.prerequisites.jobs.push({}), TypeError);
});

test('canonical parser refuses duplicate keys rather than accepting JSON last-wins', () => {
  const bytes = serializeAuthorizationManifest(authorizationFixture());
  assert.throws(() => parseAuthorizationManifest(bytes.replace(
    '"schemaVersion":2', '"schemaVersion":1,"schemaVersion":2')),
  { code: 'authorization_noncanonical' });
  assert.throws(() => parseAuthorizationManifest(bytes.replace(
    '"pullNumber":"123"', '"pullNumber":"999","pullNumber":"123"')),
  { code: 'authorization_noncanonical' });
});

test('parser and digest refuse noncanonical encodings, invalid UTF8, BOM and oversized input', () => {
  for (const bytes of [
    '', EXPECTED.trimEnd(), `${EXPECTED}\n`, ` ${EXPECTED}`, EXPECTED.replace(':2,', ': 2,'),
    EXPECTED.replace('"schemaVersion":2', '"schemaVersion":2.0'),
    EXPECTED.replace('"schemaVersion":2', '"schemaVersion":2e0'),
    EXPECTED.replace('billing-43', 'billing-\\u0034\\u0033'),
    EXPECTED.replace('"schemaVersion":2,"kind":"billing-collector-authorization"',
      '"kind":"billing-collector-authorization","schemaVersion":2'),
    `\uFEFF${EXPECTED}`, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(EXPECTED)]),
    Buffer.concat([Buffer.from(EXPECTED), Buffer.from([0xff])]),
    Buffer.from([0xc0, 0xaf]), Buffer.alloc(16_385, 0x20),
    `${EXPECTED}${' '.repeat(16_384)}`, '{}\n', null, 42, authorizationFixture(),
  ]) {
    assert.throws(() => parseAuthorizationManifest(bytes), { code: 'authorization_noncanonical' });
    assert.throws(() => authorizationDigest(bytes), { code: 'authorization_noncanonical' });
  }
});

test('digest hashes only the exact canonical bytes including the trailing LF', () => {
  const expectedDigest = createHash('sha256').update(EXPECTED, 'utf8').digest('hex');
  for (const bytes of [EXPECTED, Buffer.from(EXPECTED), new Uint8Array(Buffer.from(EXPECTED))]) {
    assert.equal(authorizationDigest(bytes), expectedDigest);
  }
  const changed = authorizationFixture();
  changed.candidate.pullNumber = '124';
  assert.notEqual(authorizationDigest(serializeAuthorizationManifest(changed)), expectedDigest);
});

test('byte parsing uses the actual bounded buffer without caller conversion hooks or size accessors', () => {
  let calls = 0;
  const invalid = Buffer.from('{}\n');
  invalid.valueOf = () => { calls++; return EXPECTED; };
  for (const parse of [parseAuthorizationManifest, authorizationDigest]) {
    assert.throws(() => parse(invalid), { code: 'authorization_noncanonical' });
  }
  const valid = new Uint8Array(Buffer.from(EXPECTED));
  for (const key of ['valueOf', 'length', 'byteLength', 'buffer', 'byteOffset']) {
    Object.defineProperty(valid, key, { get() { calls++; throw new Error('untrusted'); } });
  }
  assert.deepEqual(parseAuthorizationManifest(valid), authorizationFixture());
  const oversized = new Uint8Array(16_385);
  Object.defineProperty(oversized, 'byteLength', { value: 1 });
  oversized.valueOf = () => { calls++; return EXPECTED; };
  assert.throws(() => parseAuthorizationManifest(oversized), { code: 'authorization_noncanonical' });
  assert.equal(calls, 0);
});

for (const [field, bad] of [
  ['schemaVersion', 1], ['schemaVersion', '2'], ['kind', 'billing-validation'],
  ['executionMode', 'hosted'], ['operation', 'deploy'], ['suite', 'billing-44'],
  ['candidate.repository', 'other/Plataforma-LawX'], ['candidate.repositoryId', '1234079267'],
  ['control.repository', 'other/billing-validation-control'], ['control.repositoryId', '1384018280'],
  ['control.repository', 'lawxcompany-stack/Plataforma-LawX'], ['control.repositoryId', '1234079266'],
  ['control.ref', 'refs/heads/preview'], ['control.workflowPath', '.github/workflows/validate-billing.yml'],
  ['control.event', 'pull_request'], ['prerequisites.workflowId', '290018022'],
  ['prerequisites.workflowPath', '.github/workflows/other.yml'],
  ['collectorRelease.image', 'ghcr.io/other/billing-validation-control@sha256:' + 'a'.repeat(64)],
  ['collectorRelease.image', 'ghcr.io/lawxcompany-stack/billing-validation-control:latest'],
  ['collectorRelease.image', 'ghcr.io/lawxcompany-stack/billing-validation-control@sha256:' + 'A'.repeat(64)],
  ['collectorRelease.configDigest', 'a'.repeat(64)],
  ['executionId', 'A'.repeat(32)], ['executionId', 'a'.repeat(31)],
  ['activationCommitment', 'C'.repeat(64)],
]) {
  test(`manifest refuses invalid ${field}: ${bad}`, () => {
    const input = authorizationFixture();
    setField(input, field, bad);
    assertInvalid(input);
  });
}

test('all SHA and digest fields require exact lowercase hex lengths', () => {
  for (const [fields, size] of [
    [['candidate.sha', 'candidate.treeSha', 'candidate.baseSha', 'control.sha',
      'collectorRelease.sourceSha', 'collectorRelease.sourceTreeSha'], 40],
    [['activationCommitment', 'collectorRelease.policyDigest', 'policy.environmentDigest',
      'policy.contractsDigest', 'policy.egressDigest', 'policy.limitsDigest'], 64],
  ]) {
    for (const field of fields) {
      for (const bad of ['a'.repeat(size - 1), 'a'.repeat(size + 1), 'A'.repeat(size), 'g'.repeat(size), 123, null]) {
        const input = authorizationFixture();
        setField(input, field, bad);
        assertInvalid(input);
      }
    }
  }
});

test('every decimal ID is a canonical positive safe integer string', () => {
  for (const field of ['candidate.repositoryId', 'candidate.pullNumber', 'prerequisites.workflowId',
    'prerequisites.runId', 'prerequisites.runAttempt', 'prerequisites.jobs.0.jobId',
    'control.repositoryId', 'control.runId', 'control.runAttempt']) {
    for (const bad of ['0', '-1', '+1', '01', '1.0', '1e2', ' 1', '1\n', '9007199254740992', '99999999999999999999', 1, null]) {
      const input = authorizationFixture();
      setField(input, field, bad);
      assertInvalid(input);
    }
  }
  const input = authorizationFixture();
  input.candidate.pullNumber = '9007199254740991';
  assert.equal(createAuthorizationManifest(input).candidate.pullNumber, '9007199254740991');
});

test('all records reject extra own keys, inherited fields, symbols and accessors without executing them', () => {
  const locations = [[], ['candidate'], ['prerequisites'], ['control'], ['collectorRelease'], ['policy'],
    ['prerequisites', 'jobs', 0]];
  for (const path of locations) {
    for (const mutation of ['extra', 'hidden', 'symbol', 'accessor', 'missing', 'inherited', 'proxy']) {
      const input = authorizationFixture();
      let record = path.reduce((parent, key) => parent[key], input);
      let reads = 0;
      const first = Object.keys(record)[0];
      if (mutation === 'extra') record.extra = 'untrusted';
      if (mutation === 'hidden') Object.defineProperty(record, 'extra', { value: 'untrusted' });
      if (mutation === 'symbol') record[Symbol('extra')] = true;
      if (mutation === 'accessor') Object.defineProperty(record, first, { get() { reads++; return 'untrusted'; } });
      if (mutation === 'missing') delete record[first];
      if (mutation === 'inherited') {
        Object.setPrototypeOf(record, { [first]: record[first] });
        delete record[first];
      }
      if (mutation === 'proxy') {
        const proxy = new Proxy(record, { ownKeys() { reads++; throw new Error('untrusted'); } });
        if (path.length === 0) record = proxy;
        else path.slice(0, -1).reduce((parent, key) => parent[key], input)[path.at(-1)] = proxy;
      }
      assertInvalid(path.length === 0 ? record : input);
      assert.equal(reads, 0);
    }
  }
  for (const bad of [null, [], true, 'manifest', new Date()]) assertInvalid(bad);
});

test('jobs are exactly quality/regression/build in order with distinct IDs and success', () => {
  for (const mutate of [
    (jobs) => jobs.pop(), (jobs) => jobs.push({ ...jobs[0] }), (jobs) => jobs.reverse(),
    (jobs) => { jobs[1].jobId = jobs[0].jobId; }, (jobs) => { jobs[1].key = jobs[0].key; },
    (jobs) => { jobs[2].conclusion = 'skipped'; }, (jobs) => { delete jobs[0]; },
    (jobs) => { jobs.extra = true; }, (jobs) => { jobs[Symbol('extra')] = true; },
    (jobs) => { Object.defineProperty(jobs, '0', { get() { throw new Error('must not run'); } }); },
  ]) {
    const input = authorizationFixture();
    mutate(input.prerequisites.jobs);
    assertInvalid(input);
  }
});

test('dates require real calendar UTC milliseconds and a positive window of at most 20 minutes', () => {
  for (const [issuedAt, expiresAt] of [
    ['2026-02-30T12:00:00.000Z', '2026-03-02T12:10:00.000Z'],
    ['2026-02-29T12:00:00.000Z', '2026-03-01T12:10:00.000Z'],
    ['2026-09-29T24:00:00.000Z', '2026-09-30T00:10:00.000Z'],
    ['2026-09-29T12:00:00Z', '2026-09-29T12:10:00.000Z'],
    ['2026-09-29T12:00:00.000+00:00', '2026-09-29T12:10:00.000Z'],
    ['2026-09-29T12:00:00.000Z', '2026-09-29T12:00:00.000Z'],
    ['2026-09-29T12:00:00.000Z', '2026-09-29T11:59:59.999Z'],
    ['2026-09-29T12:00:00.000Z', '2026-09-29T12:20:00.001Z'],
    ['2026-09-29T12:00:00.000Z', '2026-09-31T12:10:00.000Z'],
    ['2026-09-29T12:00:60.000Z', '2026-09-29T12:10:00.000Z'],
    [null, '2026-09-29T12:10:00.000Z'],
  ]) assertInvalid({ ...authorizationFixture(), issuedAt, expiresAt });
  for (const expiresAt of ['2026-09-29T12:00:00.001Z', '2026-09-29T12:20:00.000Z']) {
    assert.equal(createAuthorizationManifest({ ...authorizationFixture(), expiresAt }).expiresAt, expiresAt);
  }
  assert.doesNotThrow(() => createAuthorizationManifest({ ...authorizationFixture(),
    issuedAt: '2028-02-29T12:00:00.000Z', expiresAt: '2028-02-29T12:20:00.000Z' }));
});

test('collect requires null source; recover and recheck roundtrip with a distinct valid source', () => {
  for (const sourceExecutionId of [undefined, '', '2'.repeat(32), '1'.repeat(32), 'Z'.repeat(32)]) {
    assertInvalid({ ...authorizationFixture(), sourceExecutionId });
  }
  for (const operation of ['recover', 'recheck']) {
    const input = { ...authorizationFixture(), operation, sourceExecutionId: '2'.repeat(32) };
    const expected = EXPECTED.replace('"operation":"collect"', `"operation":"${operation}"`)
      .replace('"sourceExecutionId":null', '"sourceExecutionId":"22222222222222222222222222222222"');
    assert.deepEqual(createAuthorizationManifest(input), input);
    assert.equal(serializeAuthorizationManifest(input), expected);
    assert.deepEqual(parseAuthorizationManifest(expected), input);
    assert.equal(serializeAuthorizationManifest(parseAuthorizationManifest(Buffer.from(expected))), expected);
    assert.equal(authorizationDigest(expected), createHash('sha256').update(expected).digest('hex'));
    for (const sourceExecutionId of [null, undefined, '1'.repeat(32), 'Z'.repeat(32), '2'.repeat(31)]) {
      assertInvalid({ ...input, sourceExecutionId });
    }
  }
});

test('both declared suites are understood without coercion', () => {
  for (const suite of ['billing-43', 'billing-3ds-15']) {
    assert.equal(createAuthorizationManifest({ ...authorizationFixture(), suite }).suite, suite);
  }
});
