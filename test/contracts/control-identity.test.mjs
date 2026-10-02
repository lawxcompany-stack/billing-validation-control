import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID, matchesControlRepository } from '../../src/contracts/control-identity.mjs';

test('exports the pinned control identity and matches only its exact repository and ID', () => {
  assert.equal(CONTROL_REPOSITORY, 'lawx-ai/billing-validation-control');
  assert.equal(CONTROL_REPOSITORY_ID, '1384018279');
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', '1384018279'), true);
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', 1384018279), true);
  assert.equal(matchesControlRepository('lawxcompany-stack/billing-validation-control', '1384018279'), false);
  assert.equal(matchesControlRepository('attacker/billing-validation-control', '1384018279'), false);
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', '1384018278'), false);
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', '01384018279'), false);
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', true), false);
  assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', '1384018279 '), false);
  assert.equal(matchesControlRepository(null, '1384018279'), false);
});

test('rejects noncanonical names and IDs without coercing other types', () => {
  for (const repository of [undefined, 1384018279, new String(CONTROL_REPOSITORY),
    'Lawx-ai/billing-validation-control', `${CONTROL_REPOSITORY}/`]) {
    assert.equal(matchesControlRepository(repository, '1384018279'), false);
  }
  for (const repositoryId of [undefined, null, false, 0, -1384018279, 1384018279.5,
    NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1384018279n, Symbol('id'),
    new Number(1384018279), new String('1384018279'),
    { toString() { throw new Error('ID must not be coerced'); } },
    '', '+1384018279', '1.384018279e9', '1384018279.0', ' 1384018279']) {
    assert.equal(matchesControlRepository('lawx-ai/billing-validation-control', repositoryId), false);
  }
});
