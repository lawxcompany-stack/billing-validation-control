import { immutableVercelOrigin } from '../github/deployments.mjs';
import { isVerifiedDeploymentAttestation } from './vercel.mjs';

const ROUTES = Object.freeze({ home: '/' });
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const STATIC_PATH = /^\/_next\/static\/[A-Za-z0-9._/-]+$/u;
const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font']);
const SAFE_HEADERS = new Set(['accept', 'accept-encoding', 'accept-language', 'cache-control', 'connection',
  'host', 'pragma', 'priority', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
  'referer', 'upgrade-insecure-requests', 'user-agent']);
const UI_ROLES = new Set(['alert', 'button', 'checkbox', 'combobox', 'heading', 'link', 'menuitem',
  'option', 'radio', 'status', 'switch', 'tab', 'textbox']);
const UI_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Space', 'Tab']);

export class BillingPreviewRefusal extends Error {
  constructor(code) { super(code); this.name = 'BillingPreviewRefusal'; this.code = code; }
}

function refuse(code) { throw new BillingPreviewRefusal(code); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function exactKeys(value, keys) {
  if (!record(value)) return false;
  let ownKeys;
  try { ownKeys = Reflect.ownKeys(value); } catch { return false; }
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    });
}

function validDeployment(deployment) {
  return exactKeys(deployment, ['id', 'origin']) && /^dpl_[A-Za-z0-9]+$/u.test(deployment.id) &&
    typeof deployment.origin === 'string' && immutableVercelOrigin(deployment.origin) === deployment.origin;
}

async function requestAllowed(request, origin) {
  try {
    const url = new URL(request.url());
    if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
        request.method() !== 'GET' || request.redirectedFrom() !== null) return false;
    if (typeof request.allHeaders !== 'function') return false;
    const headers = await request.allHeaders();
    if (!record(headers) || Reflect.ownKeys(headers).some((name) => typeof name !== 'string' ||
        !SAFE_HEADERS.has(name.toLowerCase()))) return false;
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== 'string' || value.length > 1024 || /[\r\n\0]/u.test(value)) return false;
      const lower = name.toLowerCase();
      if (lower === 'sec-fetch-mode' && !['cors', 'navigate', 'no-cors', 'same-origin'].includes(value)) return false;
      if (lower === 'sec-fetch-site' && !['cross-site', 'same-origin', 'same-site', 'none'].includes(value)) return false;
      if (lower === 'sec-fetch-dest' && !['document', 'empty', 'font', 'image', 'script', 'style'].includes(value)) return false;
      if (lower === 'accept-encoding' && !/^[a-z0-9,;= ._-]{1,128}$/iu.test(value)) return false;
      if (lower === 'referer') {
        const referer = new URL(value);
        if (referer.origin !== origin || referer.pathname !== '/' || referer.search || referer.hash ||
            referer.username || referer.password) return false;
      }
    }
    const resourceType = request.resourceType();
    if (url.pathname === '/') return resourceType === 'document' && request.isNavigationRequest();
    return STATIC_PATH.test(url.pathname) && !url.pathname.includes('/../') && STATIC_TYPES.has(resourceType);
  } catch { return false; }
}

async function responseWithinLimit(response, { document = false } = {}) {
  if (!response || typeof response.headers !== 'function') return false;
  let headers;
  try { headers = response.headers(); } catch { return false; }
  if (!record(headers)) return false;
  const length = headers['content-length'];
  if (typeof length !== 'string' || !/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES) return false;
  if (headers['transfer-encoding'] !== undefined &&
      (typeof headers['transfer-encoding'] !== 'string' || headers['transfer-encoding'].toLowerCase() !== 'identity')) return false;
  if (headers['content-encoding'] !== undefined &&
      (typeof headers['content-encoding'] !== 'string' || headers['content-encoding'].toLowerCase() !== 'identity')) return false;
  if (document && (typeof headers['content-type'] !== 'string' ||
      !headers['content-type'].toLowerCase().startsWith('text/html'))) return false;
  let request;
  try {
    request = response.request();
    if (typeof response.finished !== 'function' || typeof request?.sizes !== 'function') return false;
    const failure = await response.finished();
    if (failure !== null) return false;
    const sizes = await request.sizes();
    return record(sizes) && Number.isSafeInteger(sizes.responseBodySize) &&
      sizes.responseBodySize <= MAX_RESPONSE_BYTES && sizes.responseBodySize === Number(length);
  } catch { return false; }
}

function boundedUi(page, isClosed) {
  function getByRole(role, options) {
    if (isClosed() || !UI_ROLES.has(role) || !exactKeys(options, ['name']) ||
        typeof options.name !== 'string' || options.name.trim().length === 0 ||
        options.name.length > 128 || /[\r\n\0]/u.test(options.name)) refuse('preview_interaction_invalid');
    let locator;
    try { locator = page.getByRole(role, { name: options.name, exact: true }); }
    catch { refuse('preview_interaction_unavailable'); }
    async function unique() {
      if (isClosed() || typeof locator?.count !== 'function') refuse('preview_interaction_unavailable');
      let count;
      try { count = await locator.count(); } catch { refuse('preview_interaction_unavailable'); }
      if (count !== 1) refuse('preview_target_not_unique');
      return locator;
    }
    async function invoke(method, ...args) {
      const target = await unique();
      if (typeof target[method] !== 'function') refuse('preview_interaction_unavailable');
      try { await target[method](...args, { timeout: TIMEOUT_MS }); }
      catch { refuse('preview_interaction_failed'); }
      return true;
    }
    const handle = {
      async isVisible() {
        const target = await unique();
        try { return await target.isVisible(); } catch { refuse('preview_interaction_failed'); }
      },
      click() { return invoke('click'); },
      ...(role === 'textbox' ? { fill(value) {
        if (typeof value !== 'string' || value.length > 512 || /[\0]/u.test(value)) refuse('preview_interaction_invalid');
        return invoke('fill', value);
      } } : {}),
      press(key) {
        if (!UI_KEYS.has(key)) refuse('preview_interaction_invalid');
        return invoke('press', key);
      },
      ...(['checkbox', 'radio', 'switch'].includes(role) ? {
        check() { return invoke('check'); },
        uncheck() { return invoke('uncheck'); },
      } : {}),
      ...(role === 'combobox' ? { selectOption(value) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
          refuse('preview_interaction_invalid');
        }
        return invoke('selectOption', value);
      } } : {}),
    };
    return Object.freeze(handle);
  }
  return Object.freeze({ getByRole });
}

/**
 * Launch a disposable browser for the exact immutable Preview origin.
 * The only reviewed document route currently wired is `/`; product route/action
 * catalogs must be added by a later reviewed scenario contract, never by input.
 */
export async function createBillingPreviewBrowser(input = {}) {
  const validInputKeys = exactKeys(input, ['deployment', 'candidate', 'chromium']) ||
    exactKeys(input, ['deployment', 'candidate', 'deploymentAttestation', 'chromium']);
  if (!validInputKeys ||
      !validDeployment(input.deployment) ||
      !record(input.chromium) || typeof input.chromium.launch !== 'function') {
    refuse('preview_transport_unavailable');
  }
  const { deployment, candidate, deploymentAttestation, chromium } = input;
  if (!isVerifiedDeploymentAttestation(deploymentAttestation, { deployment, candidate })) {
    refuse('preview_deployment_unverified');
  }
  const origin = deployment.origin;
  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block',
      javaScriptEnabled: true, ignoreHTTPSErrors: false });
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (!await requestAllowed(request, origin)) {
        try { await route.abort('blockedbyclient'); } catch { /* route already closed */ }
        return;
      }
      let headers;
      try { headers = await request.allHeaders(); }
      catch { refuse('preview_request_blocked'); }
      try { await route.continue({ headers: { ...headers, 'accept-encoding': 'identity' } }); }
      catch { refuse('preview_request_blocked'); }
    });
  } catch {
    try { await context?.close(); } catch { /* best-effort disposal */ }
    try { await browser?.close(); } catch { /* best-effort disposal */ }
    refuse('preview_transport_unavailable');
  }

  let closed = false;
  const pages = new Set();
  async function close() {
    if (closed) return;
    closed = true;
    for (const page of pages) {
      try { await page.close(); } catch { /* best-effort disposal */ }
    }
    try { await context.close(); } catch { /* best-effort disposal */ }
    try { await browser.close(); } catch { /* best-effort disposal */ }
    pages.clear();
  }

  async function openRoute(routeId) {
    if (closed || typeof routeId !== 'string' || !Object.hasOwn(ROUTES, routeId)) {
      refuse('preview_route_not_allowlisted');
    }
    let page;
    try { page = await context.newPage(); }
    catch { refuse('preview_transport_unavailable'); }
    pages.add(page);
    try {
      page.setDefaultNavigationTimeout?.(TIMEOUT_MS);
      page.setDefaultTimeout?.(TIMEOUT_MS);
      let responseViolation = false;
      const responseChecks = new WeakMap();
      const pendingResponseChecks = new Set();
      const checkResponse = (response, isDocument) => {
        if (!responseChecks.has(response)) {
          const check = Promise.resolve().then(() => responseWithinLimit(response, { document: isDocument }))
            .catch(() => false);
          responseChecks.set(response, check);
          pendingResponseChecks.add(check);
          void check.finally(() => pendingResponseChecks.delete(check));
        }
        return responseChecks.get(response);
      };
      page.on?.('response', (response) => {
        const isDocument = response.request?.().resourceType?.() === 'document';
        void checkResponse(response, isDocument).then((valid) => {
          if (!valid) { responseViolation = true; void page.close(); }
        });
      });
      page.on?.('popup', (popup) => {
        responseViolation = true;
        void popup.close();
        void page.close();
      });
      page.on?.('dialog', (dialog) => { void dialog.dismiss(); });
      page.on?.('download', (download) => {
        responseViolation = true;
        void download.cancel();
        void page.close();
      });
      const response = await page.goto(`${origin}${ROUTES[routeId]}`, {
        waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS,
      });
      await Promise.all([...pendingResponseChecks]);
      if (responseViolation || !await checkResponse(response, true) ||
          typeof response.status !== 'function' || response.status() < 200 || response.status() >= 300) {
        try { await page.close(); } catch { /* best-effort disposal */ }
        pages.delete(page);
        refuse('preview_response_invalid');
      }
      const ui = boundedUi(page, () => closed || page.isClosed?.() === true);
      return Object.freeze({ routeId, ui });
    } catch (error) {
      try { await page.close(); } catch { /* best-effort disposal */ }
      pages.delete(page);
      if (error instanceof BillingPreviewRefusal) throw error;
      refuse('preview_navigation_failed');
    }
  }

  return Object.freeze({ deploymentId: deployment.id, origin, openRoute, close });
}

export { MAX_RESPONSE_BYTES as BILLING_PREVIEW_MAX_RESPONSE_BYTES };
