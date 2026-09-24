import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const activationUrl = new URL('../../runner/activation.mjs', import.meta.url);
const manifestUrl = new URL('../../runner/activation-manifest.mjs', import.meta.url);
const writerUrl = new URL('../../runner/write-activation-manifest.mjs', import.meta.url);
const activation = await import(activationUrl.href).catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
const manifestContract = await import(manifestUrl.href).catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
const writer = await import(writerUrl.href).catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});

function requireActivation() {
  assert.ok(activation, 'The one-use workstation activation challenge is not implemented');
  return activation;
}

function requireManifest() {
  assert.ok(manifestContract, 'The canonical activation manifest is not implemented');
  return manifestContract;
}

function requireWriter() {
  assert.ok(writer, 'The hosted workflow activation manifest writer is not implemented');
  return writer;
}

const manifestFields = Object.freeze({
  activationCommitment: 'c'.repeat(64),
  candidateRepository: 'lawxcompany-stack/Plataforma-LawX',
  candidateSha: 'a'.repeat(40),
  runnerLabel: `billing-validation-${'b'.repeat(32)}`,
  controlRepository: 'lawxcompany-stack/billing-validation-control',
  controlRepositoryId: '12345678',
  controlRef: 'refs/heads/main',
  controlWorkflowPath: '.github/workflows/validate-billing.yml',
  runId: '123456789',
  runAttempt: '2',
  controlWorkflowSha: 'd'.repeat(40),
  eventName: 'workflow_dispatch',
});
const CANONICAL_MANIFEST_BYTES = '{"activationCommitment":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","candidateRepository":"lawxcompany-stack/Plataforma-LawX","candidateSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runnerLabel":"billing-validation-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","controlRepository":"lawxcompany-stack/billing-validation-control","controlRepositoryId":"12345678","controlRef":"refs/heads/main","controlWorkflowPath":".github/workflows/validate-billing.yml","runId":"123456789","runAttempt":"2","controlWorkflowSha":"dddddddddddddddddddddddddddddddddddddddd","eventName":"workflow_dispatch"}\n';

test('activation commitment is domain-separated SHA-256 over exactly 32 nonce bytes', () => {
  const { activationCommitment } = requireActivation();
  const nonce = Buffer.alloc(32, 0x2a);
  const expected = createHash('sha256')
    .update('lawx/billing-validation/activation/v1\0', 'utf8')
    .update(nonce)
    .digest('hex');

  assert.equal(activationCommitment(nonce), expected);
  assert.throws(() => activationCommitment(Buffer.alloc(31)), { code: 'activation_nonce_invalid' });
  assert.throws(() => activationCommitment(Buffer.alloc(33)), { code: 'activation_nonce_invalid' });
});

test('activation challenge exposes only its commitment and bounded operator presentation', () => {
  const { createActivationChallenge } = requireActivation();
  const challenge = createActivationChallenge({
    candidateSha: manifestFields.candidateSha,
    runnerLabel: manifestFields.runnerLabel,
  });

  assert.match(challenge.commitment, /^[0-9a-f]{64}$/);
  assert.deepEqual(challenge.presentation, {
    commitment: challenge.commitment,
    runnerLabel: manifestFields.runnerLabel,
    candidateSha: manifestFields.candidateSha,
  });
  assert.ok(!Object.hasOwn(challenge, 'nonce'));
  assert.ok(!JSON.stringify(challenge).includes('nonce'));
  challenge.destroy();
});

test('activation challenge expires by monotonic elapsed time and is single-use', () => {
  const { createActivationChallenge, ACTIVATION_CHALLENGE_TTL_MS } = requireActivation();
  const challenge = createActivationChallenge({
    candidateSha: manifestFields.candidateSha,
    runnerLabel: manifestFields.runnerLabel,
  });

  assert.equal(ACTIVATION_CHALLENGE_TTL_MS, 20 * 60 * 1000);
  assert.doesNotThrow(() => challenge.assertUsable());
  assert.throws(() => challenge.assertUsable(Number.MAX_SAFE_INTEGER), { code: 'activation_challenge_expired' });
  assert.throws(() => challenge.consume(), { code: 'activation_challenge_consumed' });
  challenge.destroy();
});

test('activation challenge cannot be consumed or destroyed twice', () => {
  const { createActivationChallenge } = requireActivation();
  const challenge = createActivationChallenge({
    candidateSha: manifestFields.candidateSha,
    runnerLabel: manifestFields.runnerLabel,
  });

  challenge.consume();
  assert.throws(() => challenge.consume(), { code: 'activation_challenge_consumed' });
  assert.throws(() => challenge.assertUsable(), { code: 'activation_challenge_consumed' });
  challenge.destroy();
});

test('activation manifest serializes to the exact canonical closed-schema bytes', () => {
  const { createActivationManifest, serializeActivationManifest } = requireManifest();
  const manifest = createActivationManifest(manifestFields);
  assert.deepEqual(manifest, manifestFields);
  assert.equal(serializeActivationManifest(manifest), CANONICAL_MANIFEST_BYTES);
});

test('hosted workflow writer emits the exact canonical manifest bytes with a terminal newline', async () => {
  const { writeWorkflowActivationManifest } = requireWriter();
  const directory = await mkdtemp(path.join(tmpdir(), 'bvc-activation-manifest-test-'));
  const filePath = path.join(directory, 'activation-manifest.json');
  const environment = {
    ACTIVATION_MANIFEST_PATH: filePath,
    ACTIVATION_COMMITMENT: manifestFields.activationCommitment,
    CANDIDATE_REPOSITORY: 'attacker/repository-is-ignored',
    CANDIDATE_SHA: manifestFields.candidateSha,
    RUNNER_LABEL: manifestFields.runnerLabel,
    CONTROL_REPOSITORY: manifestFields.controlRepository,
    CONTROL_REPOSITORY_ID: manifestFields.controlRepositoryId,
    CONTROL_REF: manifestFields.controlRef,
    CONTROL_WORKFLOW_REF: `${manifestFields.controlRepository}/${manifestFields.controlWorkflowPath}@${manifestFields.controlRef}`,
    CONTROL_RUN_ID: manifestFields.runId,
    CONTROL_RUN_ATTEMPT: manifestFields.runAttempt,
    CONTROL_WORKFLOW_SHA: manifestFields.controlWorkflowSha,
    CONTROL_EVENT_NAME: manifestFields.eventName,
  };

  try {
    await writeWorkflowActivationManifest(environment);
    assert.equal(await readFile(filePath, 'utf8'), CANONICAL_MANIFEST_BYTES);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hosted workflow writer refuses a mismatched workflow context before writing', async () => {
  const { writeWorkflowActivationManifest } = requireWriter();
  const directory = await mkdtemp(path.join(tmpdir(), 'bvc-activation-manifest-test-'));
  const filePath = path.join(directory, 'activation-manifest.json');
  const environment = {
    ACTIVATION_MANIFEST_PATH: filePath,
    ACTIVATION_COMMITMENT: manifestFields.activationCommitment,
    CANDIDATE_REPOSITORY: manifestFields.candidateRepository,
    CANDIDATE_SHA: manifestFields.candidateSha,
    RUNNER_LABEL: manifestFields.runnerLabel,
    CONTROL_REPOSITORY: manifestFields.controlRepository,
    CONTROL_REPOSITORY_ID: manifestFields.controlRepositoryId,
    CONTROL_REF: manifestFields.controlRef,
    CONTROL_WORKFLOW_REF: 'lawxcompany-stack/billing-validation-control/.github/workflows/other.yml@refs/heads/main',
    CONTROL_RUN_ID: manifestFields.runId,
    CONTROL_RUN_ATTEMPT: manifestFields.runAttempt,
    CONTROL_WORKFLOW_SHA: manifestFields.controlWorkflowSha,
    CONTROL_EVENT_NAME: manifestFields.eventName,
  };

  try {
    await assert.rejects(writeWorkflowActivationManifest(environment), { code: 'activation_manifest_invalid' });
    await assert.rejects(readFile(filePath), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('activation manifest parser refuses noncanonical or open-schema bytes', () => {
  const { createActivationManifest, serializeActivationManifest, parseCanonicalActivationManifest } = requireManifest();
  const canonical = serializeActivationManifest(createActivationManifest(manifestFields));

  assert.deepEqual(parseCanonicalActivationManifest(Buffer.from(canonical)), manifestFields);
  assert.throws(() => parseCanonicalActivationManifest(Buffer.from(canonical.slice(0, -1))),
    { code: 'activation_manifest_noncanonical' });
  assert.throws(() => parseCanonicalActivationManifest(Buffer.from(canonical.replace('"eventName":"workflow_dispatch"',
    '"eventName":"workflow_dispatch","extra":"field"'))),
  { code: 'activation_manifest_noncanonical' });
});

test('activation manifest rejects foreign identity, malformed digest and nondecimal repository IDs', () => {
  const { createActivationManifest } = requireManifest();
  for (const fields of [
    { ...manifestFields, controlRepository: 'other/control' },
    { ...manifestFields, activationCommitment: undefined },
    { ...manifestFields, controlRepositoryId: '12x' },
    { ...manifestFields, candidateSha: 'short' },
    { ...manifestFields, activationCommitment: 'C'.repeat(64) },
    { ...manifestFields, runnerLabel: 'billing-validation-reused' },
    { ...manifestFields, eventName: 'pull_request' },
  ]) {
    assert.throws(() => createActivationManifest(fields), { code: 'activation_manifest_invalid' });
  }
});
