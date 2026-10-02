const API_ORIGIN = 'https://api.vercel.com';
const SHA1 = /^[a-f0-9]{40}$/u;
const PROJECT_ID = /^prj_[A-Za-z0-9]+$/u;
const TEAM_ID = /^team_[A-Za-z0-9]+$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export class VercelReadRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'VercelReadRefusal';
    this.code = code;
  }
}

function refuse(code = 'vercel_read_refused') {
  throw new VercelReadRefusal(code);
}

function exactOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { return false; }
  const keys = Reflect.ownKeys(descriptors);
  const required = ['token', 'candidateSha', 'projectId', 'teamId'];
  return required.every((key) => Object.hasOwn(descriptors, key)) &&
    keys.every((key) => typeof key === 'string' && ['token', 'candidateSha', 'projectId', 'teamId', 'fetchImpl'].includes(key) &&
      Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true);
}

export function createVercelReadClient(options = {}) {
  if (!exactOptions(options)) refuse('vercel_read_config_invalid');
  const { token, candidateSha, projectId, teamId, fetchImpl = globalThis.fetch } = options;
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096 || /[^\x21-\x7e]/u.test(token) ||
      typeof candidateSha !== 'string' || !SHA1.test(candidateSha) ||
      typeof projectId !== 'string' || !PROJECT_ID.test(projectId) ||
      typeof teamId !== 'string' || !TEAM_ID.test(teamId) || typeof fetchImpl !== 'function') {
    refuse('vercel_read_config_invalid');
  }

  const listQuery = new URLSearchParams({
    projectId,
    teamId,
    target: 'preview',
    sha: candidateSha,
    state: 'READY',
    limit: '20',
  });
  const listPath = `/v7/deployments?${listQuery}`;
  const detailQuery = `withGitRepoInfo=true&teamId=${teamId}`;

  function allowedPath(path) {
    if (typeof path !== 'string' || path.length > 2048 || path.includes('#') || path.startsWith('//')) return false;
    if (path === listPath) return true;
    const separator = path.indexOf('?');
    if (separator < 0 || path.slice(separator + 1) !== detailQuery) return false;
    return /^\/v13\/deployments\/dpl_[A-Za-z0-9]+$/u.test(path.slice(0, separator));
  }

  async function get(path) {
    if (!allowedPath(path)) refuse('vercel_read_path_not_allowed');
    const url = `${API_ORIGIN}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let reader;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-store',
          'User-Agent': 'billing-validation-control-vercel-preflight',
        },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response || response.status !== 200 || response.ok !== true || response.redirected === true ||
          !response.body || typeof response.body.getReader !== 'function') refuse('vercel_read_http_error');
      const length = response.headers?.get('content-length');
      if (length !== null && length !== undefined) {
        if (!/^[0-9]+$/u.test(length)) refuse('vercel_read_response_invalid');
        if (Number(length) > MAX_RESPONSE_BYTES) refuse('vercel_read_response_too_large');
      }

      reader = response.body.getReader();
      const chunks = [];
      let byteLength = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) refuse('vercel_read_timeout');
        if (done) break;
        if (!(value instanceof Uint8Array)) refuse('vercel_read_response_invalid');
        byteLength += value.byteLength;
        if (byteLength > MAX_RESPONSE_BYTES) refuse('vercel_read_response_too_large');
        chunks.push(Buffer.from(value));
      }

      let parsed;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { refuse('vercel_read_response_invalid'); }
      if (controller.signal.aborted) refuse('vercel_read_timeout');
      return parsed;
    } catch (error) {
      if (error instanceof VercelReadRefusal) throw error;
      if (controller.signal.aborted) refuse('vercel_read_timeout');
      refuse('vercel_read_transport_failed');
    } finally {
      clearTimeout(timer);
      if (reader) {
        try { reader.releaseLock(); } catch { /* The response stream is already unusable. */ }
      }
    }
  }

  return Object.freeze({ get });
}
