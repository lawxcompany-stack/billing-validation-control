import assert from 'node:assert/strict';

const EFFECTS = Object.freeze([
  'createFixture',
  'requestPreview',
  'openBrowser',
  'mutateSupabase',
  'mutateStripe',
  'sendCrm',
  'sendMailchimp',
  'reconcileFinancialEvidence',
  'unsupportedOperation',
]);

export function assertBlockedDomain({ contracts, expected, run } = {}) {
  const expectedIds = expected.map(({ id }) => id);
  assert.deepEqual(Object.keys(contracts), expectedIds);
  assert.equal(Object.isFrozen(contracts), true);

  for (const item of expected) {
    const contract = contracts[item.id];
    assert.deepEqual(contract, {
      id: item.id,
      domain: item.id.slice(0, item.id.indexOf('.')),
      disposition: 'blocked',
      reasonCode: item.reasonCode,
      blockedBy: item.blockedBy,
      maxWrites: 0,
      allowedOperations: [],
    });
    assert.equal(Object.isFrozen(contract), true);
    assert.equal(Object.isFrozen(contract.blockedBy), true);
    assert.equal(Object.isFrozen(contract.allowedOperations), true);
    assert.equal(new Set(contract.blockedBy).size, contract.blockedBy.length);

    const invocations = Object.fromEntries(EFFECTS.map((name) => [name, 0]));
    const effects = Object.fromEntries(EFFECTS.map((name) => [name, () => {
      invocations[name] += 1;
      return { status: 'passed' };
    }]));
    effects.route = Object.freeze({
      url: 'https://attacker.invalid/api/stripe/webhook',
      method: 'POST',
      action: 'stripe.charge',
    });
    let returned;
    let thrown;
    try { returned = run(item.id, effects); }
    catch (error) { thrown = error; }

    assert.equal(returned, undefined, `${item.id} must not return a result`);
    assert.ok(thrown instanceof Error, `${item.id} must refuse`);
    assert.equal(thrown.code, item.reasonCode);
    assert.equal('status' in thrown, false);
    assert.equal('passed' in thrown, false);
    assert.deepEqual(invocations, Object.fromEntries(EFFECTS.map((name) => [name, 0])));

    let missingAdapterError;
    try { run(item.id); }
    catch (error) { missingAdapterError = error; }
    assert.equal(missingAdapterError?.code, item.reasonCode);
  }
}
