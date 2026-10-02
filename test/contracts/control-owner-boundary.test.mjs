import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID, matchesControlRepository } from '../../src/contracts/control-identity.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const LEGACY_CONTROL_OWNER = 'lawxcompany-stack/billing-validation-control';
const LEGACY_COLLECTOR_IMAGE_PREFIX = `ghcr.io/${LEGACY_CONTROL_OWNER}@sha256:`;
const RELEASE_POLICY_IMAGE_MATCHER = String.raw`/^ghcr\.io\/lawxcompany-stack\/billing-validation-control@sha256:[a-f0-9]{64}$/u`;
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

function normalizeAsciiEscapes(source) {
  let normalized = '';
  let index = 0;

  while (index < source.length) {
    if (source[index] !== '\\') {
      normalized += source[index++];
      continue;
    }

    const start = index;
    while (source[index] === '\\') index++;
    const slashes = index - start;
    normalized += '\\'.repeat(Math.floor(slashes / 2));
    if (slashes % 2 === 0) continue;

    if (source[index] === '/' || source[index] === '.') {
      normalized += source[index++];
      continue;
    }

    let digits;
    let end;
    if (source.startsWith('u{', index)) {
      end = source.indexOf('}', index + 2);
      digits = end < 0 ? undefined : source.slice(index + 2, end);
      if (!digits || !/^[a-f\d]+$/iu.test(digits)) digits = undefined;
      else end++;
    } else if (source.startsWith('u', index) && /^[a-f\d]{4}$/iu.test(source.slice(index + 1, index + 5))) {
      digits = source.slice(index + 1, index + 5);
      end = index + 5;
    } else if (source.startsWith('x', index) && /^[a-f\d]{2}$/iu.test(source.slice(index + 1, index + 3))) {
      digits = source.slice(index + 1, index + 3);
      end = index + 3;
    }

    const codePoint = digits === undefined ? undefined : Number.parseInt(digits, 16);
    if (codePoint !== undefined && codePoint <= 0x7f) {
      normalized += String.fromCharCode(codePoint);
      index = end;
    } else {
      normalized += '\\';
    }
  }

  return normalized;
}

function assertNoLegacyControlOwner(path, rawSource) {
  let source = rawSource;

  if (path === 'src/authorization/manifest.mjs') {
    const imageField = /collectorRelease:\s*\(value\)\s*=>\s*record\(value,\s*\{\s*image:\s*prefixedDigest\('([^']+)'\)/u.exec(source);
    assert.ok(imageField, `${path} must scope the legacy image prefix to collectorRelease.image`);
    assert.equal(imageField[1], LEGACY_COLLECTOR_IMAGE_PREFIX,
      `${path} must retain the current collectorRelease.image prefix`);
    source = source.replace(imageField[0], imageField[0].replace(imageField[1], ''));
  }

  if (path === 'src/authorization/release-policy.mjs') {
    const collectorRelease = /collectorRelease:\s*\(pin\)\s*=>\s*record\(pin,\s*\{([\s\S]*?)\n\s*\}\)/u.exec(source);
    assert.ok(collectorRelease, `${path} must declare collectorRelease`);
    const imageMatcher = /^\s*image:\s*matches\((\/.*\/u)\),?\s*$/mu.exec(collectorRelease[1]);
    assert.equal(imageMatcher?.[1], RELEASE_POLICY_IMAGE_MATCHER,
      `${path} collectorRelease.image must use the exact pinned GHCR digest matcher`);
    source = source.replace(imageMatcher[1], '');
  }

  assert.doesNotMatch(normalizeAsciiEscapes(source), /lawxcompany-stack\/billing-validation-control/u,
    `${path} contains a legacy control owner outside the allowed collector image field`);
}

function assertCanonicalWorkflowGuards(workflow, path) {
  assert.ok(workflow?.on && Object.hasOwn(workflow.on, 'workflow_dispatch'),
    `${path} must declare workflow_dispatch`);
  assert.ok(workflow.jobs && typeof workflow.jobs === 'object', `${path} must declare jobs`);

  const authorizeJob = workflow.jobs.authorize;
  assert.ok(authorizeJob && typeof authorizeJob === 'object', `${path} must declare jobs.authorize`);
  assert.equal(typeof authorizeJob.if, 'string', `${path} jobs.authorize must have an identity guard`);
  assert.doesNotMatch(authorizeJob.if, /\|\|/u, `${path} jobs.authorize must not use disjunction`);
  assert.match(authorizeJob.if, /github\.repository\s*==\s*['"]lawx-ai\/billing-validation-control['"]/u,
    `${path} jobs.authorize must guard the canonical control repository`);
  assert.match(authorizeJob.if, /github\.repository_id\s*==\s*['"]1384018279['"]/u,
    `${path} jobs.authorize must guard the canonical control repository ID`);
}

assert.equal(CONTROL_REPOSITORY, 'lawx-ai/billing-validation-control');
assert.equal(CONTROL_REPOSITORY_ID, '1384018279');
assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', '1384018279'), true);
assert.equal(matchesControlRepository('lawxcompany-stack/billing-validation-control', '1384018279'), false);
assert.match(read('src/authorization/manifest.mjs'), /repository: literal\('lawxcompany-stack\/Plataforma-LawX'\),\s*repositoryId: literal\('1234079266'\)/u);

for (const workflowPath of [
  '.github/workflows/authorize-local-collector.yml',
  '.github/workflows/validate-billing.yml',
]) {
  assertCanonicalWorkflowGuards(YAML.parse(read(workflowPath)), workflowPath);
}

for (const path of IDENTITY_PATHS) {
  assertNoLegacyControlOwner(path, read(path));
}

const broadReleaseMatcher = read('src/authorization/release-policy.mjs')
  .replace('billing-validation-control@sha256:[a-f0-9]{64}$/u', 'billing-validation-control@sha256:.*$/u');
assert.throws(() => assertNoLegacyControlOwner('src/authorization/release-policy.mjs', broadReleaseMatcher),
  /exact pinned GHCR digest matcher/u,
  'a broad suffix must not satisfy the legacy package exception');

const misplacedManifestImage = read('src/authorization/manifest.mjs').replace(
  `image: prefixedDigest('${LEGACY_COLLECTOR_IMAGE_PREFIX}'),`,
  `image: prefixedDigest('sha256:'),\n    // unused: ${LEGACY_COLLECTOR_IMAGE_PREFIX}`,
);
assert.throws(() => assertNoLegacyControlOwner('src/authorization/manifest.mjs', misplacedManifestImage),
  /current collectorRelease\.image prefix/u,
  'the legacy package prefix must not be allowed outside collectorRelease.image');

const workflowMissingAuthorizeGuard = {
  on: { workflow_dispatch: {} },
  jobs: {
    authorize: { if: "${{ github.event_name == 'workflow_dispatch' }}" },
    another: { if: "${{ github.repository == 'lawx-ai/billing-validation-control' && github.repository_id == '1384018279' }}" },
  },
};
assert.throws(() => assertCanonicalWorkflowGuards(workflowMissingAuthorizeGuard, 'synthetic-workflow.yml'),
  /jobs\.authorize must guard the canonical control repository/u,
  'a guard elsewhere in the workflow must not compensate for a missing authorize-job guard');

test('requires an authorize job when another guarded job exists', () => {
  const workflowWithoutAuthorize = {
    on: { workflow_dispatch: {} },
    jobs: {
      reader: { if: "${{ github.repository == 'lawx-ai/billing-validation-control' && github.repository_id == '1384018279' }}" },
    },
  };

  assert.throws(() => assertCanonicalWorkflowGuards(workflowWithoutAuthorize, 'synthetic-workflow.yml'),
    /must declare jobs\.authorize/u,
    'a guarded reader must not substitute for the authorize job');
});

test('requires repository name and ID guards to be conjunctive', () => {
  const workflowWithDisjunctiveAuthorizeGuard = {
    on: { workflow_dispatch: {} },
    jobs: {
      authorize: { if: "${{ github.repository == 'lawx-ai/billing-validation-control' || github.repository_id == '1384018279' }}" },
    },
  };

  assert.throws(() => assertCanonicalWorkflowGuards(workflowWithDisjunctiveAuthorizeGuard, 'synthetic-workflow.yml'),
    /jobs\.authorize must not use disjunction/u,
    'both canonical identity predicates must be required by the authorize guard');
});

for (const encodedSlug of [
  String.raw`lawxcompany-stack\/billing-validation-control`,
  String.raw`lawxcompany-stack\u002fbilling-validation-control`,
  String.raw`lawxcompany-stack\u{2f}billing-validation-control`,
  String.raw`lawxcompany-stack\x2fbilling-validation-control`,
  String.raw`ghcr\u002eio/lawxcompany-stack\u002fbilling-validation-control`,
]) {
  assert.throws(() => assertNoLegacyControlOwner('scripts/read-candidate.mjs', `const owner = '${encodedSlug}';`),
    /legacy control owner/u,
    `ASCII escapes must not hide a legacy owner: ${encodedSlug}`);
}

assert.doesNotMatch(normalizeAsciiEscapes(String.raw`lawxcompany-stack\\u002fbilling-validation-control`),
  /lawxcompany-stack\/billing-validation-control/u,
  'escaped backslashes must not be mistaken for an encoded slash');
