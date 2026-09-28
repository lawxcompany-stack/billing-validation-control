import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIfMissing, needExport } from '../billing/support.mjs';

const endpointModule = await importIfMissing(() => import('../../src/operator/endpoint.mjs'));
const startEndpoint = (...args) => needExport(endpointModule, 'startOperatorEndpoint')(...args);

const candidateSha = 'e'.repeat(40);
const attemptId = 'attempt-endpoint-1';

function fakeChromium({ endpointForPath = (path) => `ws://127.0.0.1:43123/${path}` } = {}) {
  const calls = { launch: [], connect: [], serverClose: 0, browserClose: 0 };
  const chromium = {
    async launchServer(options) {
      calls.launch.push(options);
      return { wsEndpoint: () => endpointForPath(options.wsPath), async close() { calls.serverClose++; } };
    },
    async connect(endpoint, options) {
      calls.connect.push({ endpoint, options });
      return { async close() { calls.browserClose++; } };
    },
  };
  return { chromium, calls };
}

test('launches a headed BrowserServer on loopback with an in-memory random wsPath', async () => {
  const randomBytes = (size) => Buffer.alloc(size, 0x7a);
  const expectedPath = randomBytes(32).toString('hex');
  const expectedEndpoint = `ws://127.0.0.1:43123/${expectedPath}`;
  const { chromium, calls } = fakeChromium();
  const handle = await startEndpoint({ chromium, candidateSha, attemptId,
    randomBytes });

  assert.equal(calls.launch.length, 1);
  assert.deepEqual(calls.launch[0], { headless: false, host: '127.0.0.1', port: 0,
    wsPath: expectedPath, proxy: { server: 'http://billing-egress-proxy:3128' } });
  assert.equal(calls.connect[0].endpoint, expectedEndpoint);
  assert.equal(calls.connect[0].options, undefined);
  assert.equal(Object.hasOwn(handle, 'wsEndpoint'), false);
  assert.equal(Object.hasOwn(handle, 'capabilityUrl'), false);
  await handle.close();
});

test('refuses DNS, public, malformed, and non-loopback BrowserServer endpoints', async () => {
  let byte = 0x30;
  const invalidUrls = [
    (path) => `ws://browser.example:43123/${path}`,
    (path) => `ws://203.0.113.7:43123/${path}`,
    (path) => `ws://0.0.0.0:43123/${path}`,
    (path) => `ws://127.0.0.2:43123/${path}`,
    () => 'ws://127.0.0.1:43123/other',
    (path) => `wss://127.0.0.1:43123/${path}`,
    () => 'not-a-websocket-endpoint',
  ];
  for (const makeUrl of invalidUrls) {
    const currentByte = byte++;
    const path = currentByte.toString(16).repeat(32);
    const url = makeUrl(path);
    const { chromium, calls } = fakeChromium({ endpointForPath: () => url });
    await assert.rejects(startEndpoint({ chromium, candidateSha, attemptId,
      randomBytes: (size) => Buffer.alloc(size, currentByte) }), { code: 'operator_endpoint_invalid' });
    assert.equal(calls.connect.length, 0);
    assert.equal(calls.serverClose, 1);
  }
});

test('a previously used BrowserServer capability path cannot be reused in one process', async () => {
  const { chromium } = fakeChromium();
  const randomBytes = (size) => Buffer.alloc(size, 0x11);
  const first = await startEndpoint({ chromium, candidateSha, attemptId, randomBytes });
  await first.close();
  await assert.rejects(startEndpoint({ chromium, candidateSha, attemptId: 'attempt-endpoint-2', randomBytes }),
    { code: 'operator_endpoint_capability_reused' });
});

test('closing the operator endpoint closes the browser client and server and forbids reuse', async () => {
  const { chromium, calls } = fakeChromium();
  const handle = await startEndpoint({ chromium, candidateSha, attemptId: 'attempt-endpoint-close',
    randomBytes: (size) => Buffer.alloc(size, 0x22) });
  assert.equal(handle.closed, false);
  await handle.close();
  assert.equal(handle.closed, true);
  assert.equal(calls.browserClose, 1);
  assert.equal(calls.serverClose, 1);
  assert.throws(() => handle.browser, { code: 'operator_closed' });
});
