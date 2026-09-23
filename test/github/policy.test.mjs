import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflows = JSON.parse(readFileSync('policy/candidate-workflows.json', 'utf8'));
const sourcePins = JSON.parse(readFileSync('policy/source-pins.json', 'utf8'));

test('candidate workflow policy pins only observed repository workflow identities and the Preview PR event', () => {
  assert.equal(workflows.schema_version, 1);
  assert.equal(workflows.repository, 'lawxcompany-stack/Plataforma-LawX');
  assert.equal(workflows.base_branch, 'preview');
  assert.deepEqual(workflows.workflows.map(({ id }) => id), [290018021, 364357772, 360465212]);
  for (const workflow of workflows.workflows) {
    assert.equal(workflow.event, 'pull_request');
    assert.equal(workflow.artifact_required, true);
    assert.equal(workflow.artifact_name_suffix, '-{run_id}-{attempt}');
    assert.equal(workflow.artifact_json_path, 'evidence.json');
  }
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
