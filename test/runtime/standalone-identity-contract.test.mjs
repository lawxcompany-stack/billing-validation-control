import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidExpectedEnvironment } from '../../src/contracts/evidence.mjs';

const environment = {
  database: { projectRef: 'abcdefghijklmnopqrst' },
  deployment: { id: 'dpl_candidate123', origin: 'https://candidate.vercel.app' },
  stripe: { accountId: 'acct_synthetic123' },
};

test('billing environment uses standalone projectRef and rejects branch identities', () => {
  assert.equal(isValidExpectedEnvironment(environment), true);
  assert.equal(isValidExpectedEnvironment({ ...environment,
    database: { ...environment.database, branchId: 'synthetic-branch' } }), false);
  assert.equal(isValidExpectedEnvironment({ ...environment,
    database: { ...environment.database, parentProjectRef: 'zyxwvutsrqponmlkjihg' } }), false);
});
