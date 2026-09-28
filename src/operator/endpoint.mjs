import { randomBytes as secureRandomBytes } from 'node:crypto';

const usedPaths = new Set();
const PROXY_SERVER = 'http://billing-egress-proxy:3128';
const SHA = /^[a-f0-9]{40}$/iu;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const PATH = /^[a-f0-9]{64}$/u;

export class OperatorEndpointRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'OperatorEndpointRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new OperatorEndpointRefusal(code);
}

function validIdentity(candidateSha, attemptId) {
  return typeof candidateSha === 'string' && SHA.test(candidateSha) &&
    typeof attemptId === 'string' && ID.test(attemptId);
}

function validateEndpoint(value, wsPath) {
  let endpoint;
  try { endpoint = new URL(value); } catch { refuse('operator_endpoint_invalid'); }
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.username || endpoint.password || endpoint.pathname !== `/${wsPath}` ||
      endpoint.search || endpoint.hash) refuse('operator_endpoint_invalid');
  return endpoint.href;
}

async function closeQuietly(resource) {
  try { await resource?.close?.(); } catch { /* close must not expose browser or URL details */ }
}

export async function startOperatorEndpoint({ chromium, candidateSha, attemptId,
  randomBytes = secureRandomBytes } = {}) {
  if (!validIdentity(candidateSha, attemptId) || typeof chromium?.launchServer !== 'function' ||
      typeof chromium?.connect !== 'function' || typeof randomBytes !== 'function') {
    refuse('operator_endpoint_config_invalid');
  }

  let random;
  try { random = randomBytes(32); } catch { refuse('operator_endpoint_capability_unavailable'); }
  if (!Buffer.isBuffer(random) || random.length !== 32) refuse('operator_endpoint_capability_unavailable');
  const wsPath = random.toString('hex');
  if (!PATH.test(wsPath) || usedPaths.has(wsPath)) refuse('operator_endpoint_capability_reused');
  usedPaths.add(wsPath);

  let server;
  try {
    server = await chromium.launchServer({ headless: false, host: '127.0.0.1', port: 0, wsPath,
      proxy: { server: PROXY_SERVER } });
    const endpoint = validateEndpoint(server?.wsEndpoint?.(), wsPath);
    const browser = await chromium.connect(endpoint);
    let closed = false;
    let disconnected = false;
    const listeners = new Set();
    const onDisconnected = () => {
      if (closed || disconnected) return;
      disconnected = true;
      for (const listener of listeners) {
        try { listener(); } catch { /* observers are isolated from the browser transport */ }
      }
      listeners.clear();
    };
    browser.on?.('disconnected', onDisconnected);

    const handle = {
      get browser() {
        if (closed || disconnected) refuse('operator_closed');
        return browser;
      },
      get closed() { return closed || disconnected; },
      onDisconnected(callback) {
        if (typeof callback !== 'function') refuse('operator_disconnect_listener_invalid');
        if (disconnected) callback();
        else if (!closed) listeners.add(callback);
        return () => listeners.delete(callback);
      },
      async close() {
        if (closed) return;
        closed = true;
        listeners.clear();
        browser.off?.('disconnected', onDisconnected);
        await Promise.all([closeQuietly(browser), closeQuietly(server)]);
      },
    };
    return Object.freeze(handle);
  } catch (error) {
    await closeQuietly(server);
    if (error instanceof OperatorEndpointRefusal) throw error;
    refuse('operator_endpoint_start_failed');
  }
}

const PANEL_HTML = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Billing validation operator</title>
<style>
body{font:16px system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#17202a}
button{font:inherit;margin:.5rem .5rem .5rem 0;padding:.7rem 1rem}#message{min-height:3rem}
</style><main><h1>Billing validation operator</h1><p id="message">Waiting for a trusted control request.</p>
<button id="complete" hidden>Interaction complete</button>
<button id="checkpoint" hidden>Checkpoint complete</button>
<button id="abort" hidden>Abort</button></main>
<script>
(() => {
  let pending = null;
  const message = document.querySelector('#message');
  const complete = document.querySelector('#complete');
  const checkpoint = document.querySelector('#checkpoint');
  const abort = document.querySelector('#abort');
  window.billingOperatorRender = (request) => {
    pending = Object.freeze(request);
    message.textContent = request.kind === 'challenge' ?
      'Complete the requested challenge interaction in the application tab, then confirm here.' :
      'Complete the requested manual resend step, then confirm here.';
    complete.hidden = request.kind !== 'challenge';
    checkpoint.hidden = request.kind !== 'checkpoint';
    abort.hidden = false;
  };
  async function send(type) {
    if (!pending) return;
    const request = pending;
    const accepted = await window.__billingOperatorSignal({ version: 1, type,
      candidateSha: request.candidateSha, attemptId: request.attemptId,
      caseId: request.caseId, nonce: request.nonce });
    if (accepted) {
      pending = null;
      complete.hidden = checkpoint.hidden = abort.hidden = true;
      message.textContent = type === 'abort' ? 'Operator aborted this step.' : 'Signal accepted.';
    } else {
      message.textContent = 'Signal refused or expired. Wait for a new request.';
    }
  }
  complete.addEventListener('click', () => void send('complete'));
  checkpoint.addEventListener('click', () => void send('checkpoint'));
  abort.addEventListener('click', () => void send('abort'));
})();
</script></html>`;

export async function createOperatorPanel({ context, onSignal } = {}) {
  if (typeof context?.newPage !== 'function' || typeof onSignal !== 'function') {
    refuse('operator_panel_config_invalid');
  }
  let page;
  try {
    page = await context.newPage();
    await page.exposeFunction('__billingOperatorSignal', onSignal);
    await page.setContent(PANEL_HTML, { waitUntil: 'domcontentloaded' });
  } catch {
    await closeQuietly(page);
    refuse('operator_panel_start_failed');
  }

  let closed = false;
  return Object.freeze({
    async present(request) {
      const fields = request && Reflect.ownKeys(request).sort();
      if (closed || !Array.isArray(fields) ||
          fields.join(',') !== 'attemptId,candidateSha,caseId,kind,nonce' ||
          !['challenge', 'checkpoint'].includes(request.kind) ||
          typeof request.nonce !== 'string' || !PATH.test(request.nonce) ||
          !SHA.test(request.candidateSha ?? '') || !ID.test(request.attemptId ?? '') ||
          typeof request.caseId !== 'string') refuse('operator_panel_request_invalid');
      try { await page.evaluate((value) => window.billingOperatorRender(value), request); }
      catch { refuse('operator_panel_unavailable'); }
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeQuietly(page);
    },
  });
}
