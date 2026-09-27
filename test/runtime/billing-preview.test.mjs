import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importIfMissing, needExport } from '../billing/support.mjs';
import { verifyDeploymentAttestation } from '../../src/runtime/vercel.mjs';
import { candidate, fetchFixture, policy, signedAttestation } from './fixture.mjs';

const previewModule = await importIfMissing(() => import('../../src/runtime/billing-preview.mjs'));
const origin = 'https://lawx-abcdefgh1-preview.vercel.app';
const deployment = Object.freeze({ id: 'dpl_task4preview123', origin });
const deploymentAttestation = await verifyDeploymentAttestation({ deployment, candidate, policy,
  fetchImpl: fetchFixture(signedAttestation({ overrides: { origin, deploymentId: deployment.id } })).fetchImpl });

function fakeChromium({ urlOverride, method = 'GET', redirected = false, contentLength = '128',
  bodySize = 128, headers = { accept: 'text/html', 'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en-US', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none', 'upgrade-insecure-requests': '1', 'user-agent': 'offline-test',
    referer: `${origin}/` },
  transferEncoding, missingSizes = false } = {}) {
  const calls = { launch: 0, launchOptions: null, contextOptions: null, routes: [], requests: [],
    closed: 0, navigationResponse: null, interactions: [], routeContinueOptions: [], responseBodyReads: 0 };
  const browser = {
    async newContext(options) {
      calls.contextOptions = options;
      const context = {
        async route(pattern, handler) { calls.routes.push({ pattern, handler }); },
        async newPage() {
          const listeners = new Map();
          const page = {
            on(event, callback) { listeners.set(event, callback); },
            async goto(url, options) {
              calls.requests.push({ url, options });
              const requestUrl = urlOverride ?? url;
              const request = {
                url: () => requestUrl,
                method: () => method,
                resourceType: () => 'document',
                isNavigationRequest: () => true,
                headers: () => headers,
                async allHeaders() { return headers; },
                redirectedFrom: () => redirected ? ({ url: () => `${origin}/redirect-source` }) : null,
                ...(!missingSizes ? { async sizes() { return { responseBodySize: bodySize }; } } : {}),
              };
              let outcome = 'pending';
              const route = {
                request: () => request,
                async continue(options) { outcome = 'continued'; calls.routeContinueOptions.push(options); },
                async abort() { outcome = 'aborted'; },
              };
              await calls.routes.at(-1).handler(route);
              if (outcome !== 'continued') throw Object.assign(new Error('navigation refused'), { code: 'fake_navigation_refused' });
              calls.navigationResponse = {
                status: () => 200,
                headers: () => ({ ...(contentLength === null ? {} : { 'content-length': contentLength }),
                  ...(transferEncoding ? { 'transfer-encoding': transferEncoding } : {}),
                  'content-type': 'text/html; charset=utf-8' }),
                async body() { calls.responseBodyReads += 1; return Buffer.alloc(bodySize, 97); },
                async finished() { return null; },
                request: () => request,
              };
              await listeners.get('response')?.(calls.navigationResponse);
              return calls.navigationResponse;
            },
            getByRole(role, options) {
              calls.interactions.push({ method: 'getByRole', role, options });
              return {
                async count() { return 1; },
                async isVisible() { return true; },
                async click(options) { calls.interactions.push({ method: 'click', options }); },
                async fill(value, options) { calls.interactions.push({ method: 'fill', value, options }); },
                async press(key, options) { calls.interactions.push({ method: 'press', key, options }); },
                async check(options) { calls.interactions.push({ method: 'check', options }); },
                async uncheck(options) { calls.interactions.push({ method: 'uncheck', options }); },
                async selectOption(value, options) { calls.interactions.push({ method: 'selectOption', value, options }); },
              };
            },
            async close() { calls.closed += 1; },
          };
          return page;
        },
        async close() { calls.closed += 1; },
      };
      return context;
    },
    async close() { calls.closed += 1; },
  };
  return { calls, chromium: { async launch(options) {
    calls.launch += 1;
    calls.launchOptions = options;
    return browser;
  } } };
}

test('Preview transport opens only a pinned immutable HTTPS deployment in a disposable browser context', async () => {
  const create = needExport(previewModule, 'createBillingPreviewBrowser');
  const fake = fakeChromium();
  const transport = await create({ deployment, candidate, deploymentAttestation, chromium: fake.chromium });
  const pageHandle = await transport.openRoute('home');

  assert.equal(pageHandle.routeId, 'home');
  assert.equal(fake.calls.launch, 1);
  assert.deepEqual(fake.calls.launchOptions, { headless: true });
  assert.equal(fake.calls.contextOptions.acceptDownloads, false);
  assert.equal(fake.calls.contextOptions.serviceWorkers, 'block');
  assert.equal(fake.calls.requests[0].url, `${origin}/`);
  assert.equal(fake.calls.requests[0].options.waitUntil, 'domcontentloaded');
  assert.equal(fake.calls.closed, 0);
  assert.equal(fake.calls.responseBodyReads, 0, 'size verification must not copy the full response body into Node');
  assert.equal(typeof pageHandle.ui.getByRole, 'function');
  await pageHandle.ui.getByRole('button', { name: 'Continue' }).click();
  assert.equal(fake.calls.interactions.at(-1).method, 'click');
  assert.equal(fake.calls.interactions.at(-1).options.timeout, 10_000);
  await transport.close();
  assert.ok(fake.calls.closed > 0);
});

test('a valid immutable deployment ID and origin are refused without their candidate attestation before launch', async () => {
  const create = needExport(previewModule, 'createBillingPreviewBrowser');
  const fake = fakeChromium();

  await assert.rejects(create({ deployment, candidate, chromium: fake.chromium }),
    { code: 'preview_deployment_unverified' });

  assert.equal(fake.calls.launch, 0);
});

test('a copied deployment attestation object is not a verifier-owned capability', async () => {
  const create = needExport(previewModule, 'createBillingPreviewBrowser');
  const fake = fakeChromium();
  const forgedAttestation = { ...deploymentAttestation };

  await assert.rejects(create({ deployment, candidate, deploymentAttestation: forgedAttestation,
    chromium: fake.chromium }), { code: 'preview_deployment_unverified' });

  assert.equal(fake.calls.launch, 0);
});

test('a verifier-owned deployment capability is bound to the exact deployment and candidate tree', async () => {
  const create = needExport(previewModule, 'createBillingPreviewBrowser');
  const fake = fakeChromium();

  await assert.rejects(create({ deployment, candidate: { ...candidate, treeSha: 'f'.repeat(40) },
    deploymentAttestation, chromium: fake.chromium }), { code: 'preview_deployment_unverified' });
  await assert.rejects(create({ deployment: { ...deployment, id: 'dpl_otherpreview123' }, candidate,
    deploymentAttestation, chromium: fake.chromium }), { code: 'preview_deployment_unverified' });

  assert.equal(fake.calls.launch, 0);
});

test('transport refuses mutable deployment aliases, unpinned IDs, and caller-supplied URL/header/script policy before launch', async () => {
  const create = needExport(previewModule, 'createBillingPreviewBrowser');
  const fake = fakeChromium();
  for (const badDeployment of [
    { id: 'dpl_task4preview123', origin: 'https://preview.lawx.ai' },
    { id: 'preview-alias', origin },
    { id: 'dpl_task4preview123', origin: 'https://lawx-abcdefgh1-preview.vercel.app/other' },
  ]) {
    await assert.rejects(create({ deployment: badDeployment, candidate, deploymentAttestation, chromium: fake.chromium }));
  }
  await assert.rejects(create({ deployment, candidate, deploymentAttestation, chromium: fake.chromium,
    url: `${origin}/unreviewed` }));
  await assert.rejects(create({ deployment, candidate, deploymentAttestation, chromium: fake.chromium,
    headers: { Authorization: 'Bearer secret' } }));
  await assert.rejects(create({ deployment, candidate, deploymentAttestation, chromium: fake.chromium,
    script: 'globalThis.injected = true' }));
  assert.equal(fake.calls.launch, 0);
});

test('route policy rejects redirect chains, off-origin URLs, non-GET methods, query strings, and unknown paths', async () => {
  const create = needExport(previewModule, 'createBillingPreviewBrowser');
  for (const mode of [
    { redirected: true },
    { urlOverride: 'https://evil.example/steal' },
    { method: 'POST' },
    { urlOverride: `${origin}/?next=https://evil.example` },
    { urlOverride: `${origin}/api/internal/deployment-identity` },
  ]) {
    const fake = fakeChromium(mode);
    const transport = await create({ deployment, candidate, deploymentAttestation, chromium: fake.chromium });
    await assert.rejects(transport.openRoute('home'));
    assert.equal(fake.calls.requests.length, 1);
    await transport.close();
  }
});

test('request headers are deny-by-default and credentials or caller-controlled headers are rejected', async () => {
  const create = needExport(previewModule, 'createBillingPreviewBrowser');
  for (const headers of [
    { accept: 'text/html', authorization: 'Bearer private' },
    { accept: 'text/html', cookie: 'session=private' },
    { accept: 'text/html', 'x-api-key': 'private' },
    { accept: 'text/html', 'x-unreviewed': 'value' },
    { accept: 'text/html', referer: 'https://evil.example/' },
  ]) {
    const fake = fakeChromium({ headers });
    const transport = await create({ deployment, candidate, deploymentAttestation, chromium: fake.chromium });
    await assert.rejects(transport.openRoute('home'));
    assert.equal(fake.calls.routeContinueOptions.length, 0);
    await transport.close();
  }
  const safe = fakeChromium();
  const transport = await create({ deployment, candidate, deploymentAttestation, chromium: safe.chromium });
  await transport.openRoute('home');
  assert.equal(safe.calls.routeContinueOptions[0].headers['accept-encoding'], 'identity');
  await transport.close();
});

test('route API exposes no raw Playwright page, arbitrary URL, script execution, session persistence, or artifact capture', async () => {
  const create = needExport(previewModule, 'createBillingPreviewBrowser');
  const fake = fakeChromium();
  const transport = await create({ deployment, candidate, deploymentAttestation, chromium: fake.chromium });
  const pageHandle = await transport.openRoute('home');
  for (const forbidden of ['goto', 'evaluate', 'addInitScript', 'route', 'setExtraHTTPHeaders',
    'storageState', 'screenshot', 'video', 'tracing', 'responseBody']) {
    assert.equal(Object.hasOwn(pageHandle, forbidden), false, `${forbidden} is not exposed`);
    assert.equal(Object.hasOwn(transport, forbidden), false, `${forbidden} is not exposed`);
  }
  assert.equal(Object.hasOwn(pageHandle, 'ui'), true);
  for (const forbidden of ['goto', 'evaluate', 'locator', 'route', 'context', 'browser', 'screenshot']) {
    assert.equal(Object.hasOwn(pageHandle.ui, forbidden), false);
  }
  assert.equal(typeof transport.openUrl, 'undefined');
  assert.equal(Object.hasOwn(fake.calls.contextOptions, 'storageState'), false);
  assert.equal(Object.hasOwn(fake.calls.contextOptions, 'recordVideo'), false);
  assert.equal(Object.hasOwn(fake.calls.contextOptions, 'httpCredentials'), false);
  await transport.close();
});

test('missing, chunked, false-length, oversized and non-document responses fail closed without exporting bodies', async () => {
  const create = needExport(previewModule, 'createBillingPreviewBrowser');
  for (const mode of [
    { contentLength: String(20 * 1024 * 1024), bodySize: 20 * 1024 * 1024 },
    { contentLength: null },
    { transferEncoding: 'chunked' },
    { contentLength: '3', bodySize: 128 },
    { missingSizes: true },
  ]) {
    const fake = fakeChromium(mode);
    const transport = await create({ deployment, candidate, deploymentAttestation, chromium: fake.chromium });
    await assert.rejects(transport.openRoute('home'));
    assert.equal(Object.hasOwn(transport, 'responseBody'), false);
    assert.equal(fake.calls.responseBodyReads, 0);
    await transport.close();
  }
});
