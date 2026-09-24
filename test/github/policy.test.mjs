import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflows = JSON.parse(readFileSync('policy/candidate-workflows.json', 'utf8'));
const sourcePins = JSON.parse(readFileSync('policy/source-pins.json', 'utf8'));

test('candidate workflow policy pins only observed repository workflow identities and the Preview PR event', () => {
  assert.equal(workflows.schema_version, 1);
  assert.equal(workflows.repository, 'lawxcompany-stack/Plataforma-LawX');
  assert.equal(workflows.base_branch, 'preview');
  assert.deepEqual(workflows.workflows, [{
    id: 290018021,
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    suite: 'ci',
    artifact_required: true,
    artifact_name_template: 'acceptance-final-{run_id}-{attempt}',
    artifact_json_path: 'billing-acceptance.json',
    expected_categories: ['quality', 'regression', 'build', 'remote-sql', 'remote-concurrency', 'financial-e2e'],
  }]);
});

test('source pin policy fails closed until a protected path has a reviewed immutable blob hash', () => {
  assert.equal(sourcePins.schema_version, 1);
  assert.ok(sourcePins.protected_prefixes.includes('.github/workflows/'));
  assert.ok(sourcePins.protected_prefixes.includes('.github/actions/'));
  assert.ok(sourcePins.protected_prefixes.includes('scripts/'));
  assert.ok(sourcePins.protected_prefixes.includes('test/'));
  assert.ok(sourcePins.protected_prefixes.includes('tests/'));
  assert.ok(sourcePins.protected_paths.includes('package.json'));
  assert.ok(sourcePins.protected_paths.includes('pnpm-lock.yaml'));
  assert.deepEqual(sourcePins.reviewed_blobs, {});
});
