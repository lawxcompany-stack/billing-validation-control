import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID, matchesControlRepository } from '../../src/contracts/control-identity.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const IDENTITY_PATHS = [
  '.github/workflows/authorize-local-collector.yml',
  '.github/workflows/validate-billing.yml',
  'scripts/read-candidate.mjs',
  'src/contracts/control-identity.mjs',
  'src/contracts/dispatch.mjs',
  'src/contracts/attempt.mjs',
  'src/authorization/dispatch.mjs',
  'src/authorization/context.mjs',
  'src/authorization/manifest.mjs',
  'src/authorization/verifier-internal.mjs',
  'src/authorization/release-policy.mjs',
  'runner/entrypoint.sh',
  'runner/trust-policy.mjs',
  'runner/workflow-context-internal.mjs',
  'runner/activation-manifest.mjs',
  'runner/write-activation-manifest.mjs',
  'runner/activation-verifier-internal.mjs',
  'runner/billing-result-manifest.mjs',
  'runner/billing-result-verifier-internal.mjs',
];
const OLD_OWNER_PACKAGE_ALLOWLIST = new Map([
  ['src/authorization/manifest.mjs', 'ghcr.io/lawxcompany-stack/billing-validation-control@sha256:'],
  ['src/authorization/release-policy.mjs', String.raw`ghcr\.io\/lawxcompany-stack\/billing-validation-control@sha256:`],
]);

assert.equal(CONTROL_REPOSITORY, 'lawx-ai/billing-validation-control');
assert.equal(CONTROL_REPOSITORY_ID, '1384018279');
assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', '1384018279'), true);
assert.equal(matchesControlRepository('lawxcompany-stack/billing-validation-control', '1384018279'), false);
assert.match(read('src/authorization/manifest.mjs'), /repository: literal\('lawxcompany-stack\/Plataforma-LawX'\),\s*repositoryId: literal\('1234079266'\)/u);

for (const workflowPath of [
  '.github/workflows/authorize-local-collector.yml',
  '.github/workflows/validate-billing.yml',
]) {
  const workflow = read(workflowPath);
  assert.match(workflow, /github\.repository == 'lawx-ai\/billing-validation-control'/u);
  assert.match(workflow, /github\.repository_id == '1384018279'/u);
}

for (const path of IDENTITY_PATHS) {
  let source = read(path).replaceAll('\\.', '.').replaceAll('\\/', '/');
  const packageReference = OLD_OWNER_PACKAGE_ALLOWLIST.get(path);
  if (packageReference !== undefined) {
    const normalizedReference = packageReference.replaceAll('\\.', '.').replaceAll('\\/', '/');
    assert.equal(source.split(normalizedReference).length - 1, 1, `${path} must retain exactly one pinned GHCR reference`);
    source = source.replace(normalizedReference, '');
  }
  assert.doesNotMatch(source, /lawxcompany-stack\/billing-validation-control/u, `${path} contains a legacy control owner`);
}
