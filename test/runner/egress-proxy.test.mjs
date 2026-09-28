import assert from 'node:assert/strict';
import { test } from 'node:test';

const proxy = await import('../../runner/egress-proxy.mjs').catch(() => ({}));

test('proxy target authorization permits only allowlisted HTTPS CONNECT authorities', async () => {
  assert.equal(typeof proxy.authorizeEgressTarget, 'function');
  const allowedHosts = proxy.buildEgressAllowlist(['preview.example.test', 'api.stripe.com']);
  const lookup = async (hostname) => [{ address: hostname === 'api.stripe.com' ? '8.8.8.8' : '1.1.1.1', family: 4 }];
  const target = await proxy.authorizeEgressTarget('api.stripe.com:443', { allowedHosts, lookup });
  assert.equal(target.host, 'api.stripe.com');
  assert.equal(target.port, 443);
  assert.equal(target.address, '8.8.8.8');
  await assert.rejects(proxy.authorizeEgressTarget('api.stripe.com:80', { allowedHosts, lookup }),
    { code: 'egress_destination_not_allowlisted' });
  await assert.rejects(proxy.authorizeEgressTarget('attacker.example:443', { allowedHosts, lookup }),
    { code: 'egress_destination_not_allowlisted' });
});

test('proxy target authorization refuses DNS rebinding to private or metadata addresses', async () => {
  assert.equal(typeof proxy.authorizeEgressTarget, 'function');
  const allowedHosts = proxy.buildEgressAllowlist(['preview.example.test']);
  for (const addresses of [[{ address: '169.254.169.254', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.4', family: 4 }],
    [{ address: '::1', family: 6 }]]) {
    await assert.rejects(proxy.authorizeEgressTarget('preview.example.test:443', {
      allowedHosts, lookup: async () => addresses,
    }), { code: 'egress_private_address_refused' });
  }
});

test('proxy wildcard matches only its declared subdomain suffix and never broad user rules', () => {
  assert.equal(typeof proxy.assertAllowedProxyHost, 'function');
  const allowedHosts = proxy.buildEgressAllowlist([]);
  assert.equal(proxy.assertAllowedProxyHost('runner.actions.githubusercontent.com', allowedHosts),
    'runner.actions.githubusercontent.com');
  assert.throws(() => proxy.assertAllowedProxyHost('githubusercontent.com', allowedHosts),
    { code: 'egress_destination_not_allowlisted' });
  assert.throws(() => proxy.assertAllowedProxyHost('a.githubusercontent.com', allowedHosts),
    { code: 'egress_destination_not_allowlisted' });
});
