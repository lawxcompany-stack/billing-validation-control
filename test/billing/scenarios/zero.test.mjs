import { test } from 'node:test';
import { importIfMissing, needExport, needValue } from '../support.mjs';
import { assertBlockedDomain } from './support.mjs';

const scenarios = await importIfMissing(() => import('../../../src/billing/scenarios/zero.mjs'));

const common = [
  'zero_independent_authorization_reader_unavailable',
  'zero_append_only_receipt_reader_unavailable',
];

test('both canonical zero-total cases are immutable zero-write blocks before every side effect', () => {
  const expected = [
    ['zero.authorized', 'zero_authorization_persistence_oracle_unavailable'],
    ['zero.replay', 'zero_replay_finalizer_reader_unavailable'],
  ].map(([id, reasonCode]) => ({ id, reasonCode, blockedBy: [...common, reasonCode] }));

  assertBlockedDomain({ contracts: needValue(scenarios, 'ZERO_SCENARIOS'), expected,
    run: needExport(scenarios, 'runZeroScenario') });
});
