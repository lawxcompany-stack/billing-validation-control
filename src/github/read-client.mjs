const API_ORIGIN = 'https://api.github.com';
const REPOSITORY_PREFIX = '/repos/lawxcompany-stack/Plataforma-LawX/';
const FULL_SHA = /^[0-9a-fA-F]{40}$/u;
const PAGE_QUERY = { per_page: (value) => value === '100', page: positiveInteger };

export class CandidateReadRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'CandidateReadRefusal';
    this.code = code;
  }
}

function refusal(code) {
  return new CandidateReadRefusal(code);
}

function positiveInteger(value) {
  return /^[1-9][0-9]{0,15}$/u.test(value) && Number.isSafeInteger(Number(value));
}

function allowedPath(path) {
  // Validate the raw spelling before URL parsing can normalize traversal or escapes.
  if (typeof path !== 'string' || path.length > 1024 ||
      /[^A-Za-z0-9_/?=&-]/u.test(path) || !path.startsWith(REPOSITORY_PREFIX)) return false;
  const parts = path.slice(REPOSITORY_PREFIX.length).split('?');
  if (parts.length > 2 || parts[1] === '') return false;
  const [route, query] = parts;
  let rules;
  let match;
  if (/^commits\/[0-9a-fA-F]{40}\/pulls$/u.test(route)) {
    rules = PAGE_QUERY;
  } else if ((match = /^pulls\/([0-9]+)\/files$/u.exec(route))) {
    if (!positiveInteger(match[1])) return false;
    rules = PAGE_QUERY;
  } else if (/^git\/commits\/[0-9a-fA-F]{40}$/u.test(route)) {
    rules = {};
  } else if (/^git\/trees\/[0-9a-fA-F]{40}$/u.test(route)) {
    rules = { recursive: (value) => value === '1' };
  } else if (route === 'actions/workflows/290018021/runs') {
    rules = { ...PAGE_QUERY, head_sha: (value) => FULL_SHA.test(value), event: (value) => value === 'pull_request' };
  } else if ((match = /^actions\/runs\/([0-9]+)\/attempts\/([0-9]+)(\/jobs)?$/u.exec(route))) {
    if (!positiveInteger(match[1]) || !positiveInteger(match[2])) return false;
    rules = match[3] ? PAGE_QUERY : {};
  } else {
    return false;
  }

  const fields = query === undefined ? [] : query.split('&');
  if (fields.length !== Object.keys(rules).length) return false;
  const seen = new Set();
  for (const field of fields) {
    const pair = field.split('=');
    if (pair.length !== 2) return false;
    const [key, value] = pair;
    if (!Object.hasOwn(rules, key) || seen.has(key) || !rules[key](value)) return false;
    seen.add(key);
  }
  return true;
}

export function createCandidateReadClient(options = {}) {
  let token, fetchImpl, timeoutMs, maxBytes;
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error();
    ({ token, fetchImpl = globalThis.fetch, timeoutMs = 10_000, maxBytes = 8 * 1024 * 1024 } = options);
    if (typeof token !== 'string' || token.length === 0 || /[^\x21-\x7e]/u.test(token) ||
        typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 || timeoutMs > 60_000 || !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error();
  } catch {
    throw refusal('candidate_read_config_invalid');
  }

  async function get(path) {
    if (!allowedPath(path)) throw refusal('candidate_read_path_not_allowed');
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    let response, reader, timer;
    let timedOut = false;
    let failureCode = 'candidate_read_transport_failed';

    function fail(code) {
      failureCode = code;
      throw refusal(code);
    }

    function cancelBody() {
      // Cleanup must neither expose an upstream error nor extend the deadline.
      try {
        Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {});
      } catch { /* A broken or locked stream is already unusable. */ }
    }

    function checkDeadline() {
      // Also bound streams whose immediately resolved reads starve the timer.
      if (timedOut || performance.now() >= deadline) fail('candidate_read_timeout');
    }

    async function readResponse() {
      response = await fetchImpl(`${API_ORIGIN}${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'billing-validation-control-candidate-reader',
        },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        cancelBody();
        fail('candidate_read_timeout');
      }
      checkDeadline();
      if (!response || response.status !== 200 || response.ok !== true || response.redirected) {
        fail('candidate_read_http_error');
      }
      const length = response.headers?.get('content-length');
      if (length !== null && length !== undefined) {
        if (!/^[0-9]+$/u.test(length)) fail('candidate_read_response_invalid');
        if (Number(length) > maxBytes) fail('candidate_read_response_too_large');
      }
      if (!response.body || typeof response.body.getReader !== 'function') fail('candidate_read_response_invalid');
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const text = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        checkDeadline();
        if (done) break;
        if (!(value instanceof Uint8Array)) fail('candidate_read_response_invalid');
        size += value.byteLength;
        if (size > maxBytes) fail('candidate_read_response_too_large');
        if (value.byteLength === 0) continue;
        try { text.push(decoder.decode(value, { stream: true })); }
        catch { fail('candidate_read_response_invalid'); }
      }
      let result;
      try { result = JSON.parse(text.join('') + decoder.decode()); }
      catch { fail('candidate_read_response_invalid'); }
      checkDeadline();
      return result;
    }

    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(refusal('candidate_read_timeout'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([readResponse(), timeout]);
    } catch {
      controller.abort();
      cancelBody();
      // Never propagate an upstream Error, including its code, message, or cause.
      throw refusal(timedOut ? 'candidate_read_timeout' : failureCode);
    } finally {
      clearTimeout(timer);
      try { reader?.releaseLock(); } catch { /* Cancellation may still be settling. */ }
    }
  }

  return Object.freeze({ get });
}
