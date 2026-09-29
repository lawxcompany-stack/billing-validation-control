import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { after, before, mock, test } from 'node:test';
import { CandidateReadRefusal, createCandidateReadClient } from '../../src/github/read-client.mjs';
import { resolveCandidate } from '../../src/github/candidate.mjs';

const prefix = '/repos/lawxcompany-stack/Plataforma-LawX';
const sha = '0123456789abcdef0123456789abcdef01234567';
const commitPath = `${prefix}/git/commits/${sha}`;
const token = 'github_pat_TEST_SECRET';
const secret = `${token}: private response and transport detail`;

before(() => mock.method(globalThis, 'fetch', () => {
  throw new Error('Unexpected use of live fetch');
}));
after(() => mock.restoreAll());

function sanitized(code) {
  return (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error instanceof CandidateReadRefusal);
    assert.equal(error.name, 'CandidateReadRefusal');
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(inspect(error, { showHidden: true }).includes(token), false);
    assert.equal(inspect(error, { showHidden: true }).includes('private response'), false);
    return true;
  };
}

function clientWith(fetchImpl, options = {}) {
  return createCandidateReadClient({ token, fetchImpl, ...options });
}

function streamResponse(chunks, { headers, cancel = () => {} } = {}) {
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset < chunks.length) controller.enqueue(chunks[offset++]);
      else controller.close();
    },
    cancel,
  }, { highWaterMark: 0 }), { headers });
}

test('imports without ambient access or dependencies and exports the factory and refusal class', () => {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { createContext, SourceTextModule } from 'node:vm';
    const rejectAccess = () => { throw new Error('Unexpected ambient access'); };
    const context = createContext({});
    for (const name of ['process', 'fetch', 'setTimeout', 'setInterval', 'console']) {
      Object.defineProperty(context, name, { get: rejectAccess });
    }
    const module = new SourceTextModule(readFileSync(new URL(process.argv[1]), 'utf8'), { context });
    await module.link(() => { throw new Error('Unexpected dependency'); });
    await module.evaluate({ timeout: 1000 });
    assert.deepEqual(Object.keys(module.namespace), ['CandidateReadRefusal', 'createCandidateReadClient']);
    const client = module.namespace.createCandidateReadClient({ token: 'fixture', fetchImpl: async () => {
      throw new Error('Unexpected fetch during construction');
    } });
    assert.equal(Object.isFrozen(client), true);
  `, new URL('../../src/github/read-client.mjs', import.meta.url).href], {
    encoding: 'utf8', timeout: 2000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('exposes only a frozen get capability and uses fixed-origin authenticated GETs', async () => {
  let request;
  const client = clientWith(async (url, options) => {
    request = { url, options };
    return Response.json({ sha });
  });
  assert.equal(Object.isFrozen(client), true);
  assert.deepEqual(Reflect.ownKeys(client), ['get']);
  assert.deepEqual(await client.get(commitPath), { sha });
  assert.equal(request.url, `https://api.github.com${commitPath}`);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.credentials, 'omit');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(request.options.signal.aborted, false);
  const headers = new Headers(request.options.headers);
  assert.equal(headers.get('authorization'), `Bearer ${token}`);
  assert.equal(headers.get('accept'), 'application/vnd.github+json');
  assert.equal(headers.get('x-github-api-version'), '2022-11-28');
  assert.equal(request.options.cache, 'no-store');
  headers.delete('authorization');
  assert.equal(JSON.stringify([...headers]).includes(token), false);
  const { headers: ignored, ...otherOptions } = request.options;
  assert.equal(JSON.stringify({ url: request.url, ...otherOptions }).includes(token), false);
  assert.equal(Object.hasOwn(request.options, 'body'), false);
  assert.equal(JSON.stringify(client).includes(token), false);
});

test('accepts every specified endpoint, uppercase hex, and validated query order', async () => {
  const paths = [
    `${prefix}/commits/${sha}/pulls?per_page=100&page=1`,
    `${prefix}/commits/${sha.toUpperCase()}/pulls?page=2&per_page=100`,
    `${prefix}/pulls/42/files?per_page=100&page=3`,
    `${prefix}/pulls/9007199254740991/files?page=1&per_page=100`,
    commitPath,
    `${prefix}/git/commits/${sha.toUpperCase()}`,
    `${prefix}/git/trees/${sha}?recursive=1`,
    `${prefix}/actions/workflows/290018021/runs?head_sha=${sha}&event=pull_request&per_page=100&page=1`,
    `${prefix}/actions/workflows/290018021/runs?page=2&per_page=100&event=pull_request&head_sha=${sha.toUpperCase()}`,
    `${prefix}/actions/runs/123/attempts/1`,
    `${prefix}/actions/runs/123/attempts/2/jobs?per_page=100&page=1`,
    `${prefix}/actions/runs/9007199254740991/attempts/9007199254740991/jobs?page=9007199254740991&per_page=100`,
  ];
  const calls = [];
  const client = clientWith(async (url) => {
    calls.push(url);
    return Response.json([]);
  });
  for (const path of paths) assert.deepEqual(await client.get(path), []);
  assert.deepEqual(calls, paths.map((path) => `https://api.github.com${path}`));
});

test('rejects other origins, repositories, routes, normalization tricks, and path types before fetch', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return Response.json({}); });
  const rejected = [
    `https://api.github.com${commitPath}`, `http://api.github.com${commitPath}`,
    `https://attacker.example${commitPath}`, `//api.github.com${commitPath}`,
    new URL(`https://api.github.com${commitPath}`), null, undefined, 42, {},
    { toString() { throw new Error(secret); } },
    commitPath.slice(1), commitPath.replace('lawxcompany-stack', 'attacker'),
    commitPath.replace('Plataforma-LawX', 'another-repo'),
    commitPath.replace('Plataforma-LawX', 'plataforma-lawx'),
    `${prefix}/issues`, `${prefix}/pulls/42`, `${prefix}/pulls/42/merge`,
    `${prefix}/actions/runs/123/cancel`, `${prefix}/actions/runs/123/rerun`,
    `${prefix}/actions/runs/123/artifacts`, `${prefix}/actions/runs/123/jobs?per_page=100&page=1`,
    `${prefix}/actions/workflows/290018021/dispatches`,
    `${prefix}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=pull_request&per_page=100&page=1`,
    `${prefix}/actions/workflows/290018022/runs?head_sha=${sha}&event=pull_request&per_page=100&page=1`,
    `${prefix}/git/commits/main`, `${prefix}/git/commits/${'a'.repeat(39)}`,
    `${prefix}/git/commits/${'a'.repeat(41)}`, `${prefix}/git/commits/${'g'.repeat(40)}`,
    `${prefix}/../Plataforma-LawX/git/commits/${sha}`,
    `${prefix}/./git/commits/${sha}`, `${prefix}//git/commits/${sha}`,
    `${prefix}/%2e%2e/git/commits/${sha}`, `${prefix}/git%2fcommits/${sha}`,
    `${prefix}/git%252fcommits/${sha}`, commitPath.replace('/git/', '\\git/'),
    `${commitPath}/`, `${commitPath}#fragment`, `${commitPath}?`,
    ` ${commitPath}`, `${commitPath}\n`, `${commitPath}\r`, `${commitPath}\0`,
    `${prefix}/git/commits/${sha}%00`, `${commitPath}?access_token=${token}`,
  ];
  for (const path of rejected) {
    await assert.rejects(client.get(path), sanitized('candidate_read_path_not_allowed'));
  }
  assert.equal(calls, 0);
});

test('requires canonical positive safe integers in every id, attempt, and page', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return Response.json({}); });
  for (const value of ['0', '-1', '+1', '01', '1.0', '1e2', 'Infinity', '9007199254740992', '9'.repeat(500)]) {
    for (const path of [
      `${prefix}/pulls/${value}/files?per_page=100&page=1`,
      `${prefix}/commits/${sha}/pulls?per_page=100&page=${value}`,
      `${prefix}/pulls/42/files?per_page=100&page=${value}`,
      `${prefix}/actions/runs/${value}/attempts/1`,
      `${prefix}/actions/runs/123/attempts/${value}`,
      `${prefix}/actions/runs/${value}/attempts/1/jobs?per_page=100&page=1`,
      `${prefix}/actions/runs/123/attempts/${value}/jobs?per_page=100&page=1`,
      `${prefix}/actions/runs/123/attempts/1/jobs?per_page=100&page=${value}`,
      `${prefix}/actions/workflows/290018021/runs?head_sha=${sha}&event=pull_request&per_page=100&page=${value}`,
    ]) await assert.rejects(client.get(path), sanitized('candidate_read_path_not_allowed'));
  }
  assert.equal(calls, 0);
});

test('rejects missing, duplicate, unknown, encoded, and malformed query parameters', async () => {
  let calls = 0;
  const client = clientWith(async () => { calls += 1; return Response.json({}); });
  const pageQueries = [
    '', '?', '?per_page=100', '?page=1', '?per_page=99&page=1',
    '?per_page=0100&page=1', '?per_page=100&page=1&page=1',
    '?per_page=100&per_page=100&page=1', '?per_page=100&page=1&unknown=1',
    '?per_page=100&page=1&', '?&per_page=100&page=1', '?per_page=100&&page=1',
    '?per_page=100&page=', '?per_page=100&page=1=2', '?per_page=100&page=1?x=2',
    '?per_page=100&%70age=1', '?per_page=100&page=%31', '?per_page=100&page=1#x',
    '?per_page=100;page=1', '?per_page=100&page=1\n', '?per_page=100&PAGE=1',
  ];
  for (const base of [
    `${prefix}/commits/${sha}/pulls`, `${prefix}/pulls/42/files`,
    `${prefix}/actions/runs/123/attempts/1/jobs`,
  ]) {
    for (const query of pageQueries) {
      await assert.rejects(client.get(base + query), sanitized('candidate_read_path_not_allowed'));
    }
  }
  for (const path of [
    `${commitPath}?page=1`, `${prefix}/actions/runs/123/attempts/1?per_page=100&page=1`,
    `${prefix}/git/trees/${sha}`, `${prefix}/git/trees/${sha}?recursive=0`,
    `${prefix}/git/trees/${sha}?recursive=1&recursive=1`, `${prefix}/git/trees/${sha}?recursive=1&page=1`,
    ...[
      'per_page=100&page=1', `head_sha=${sha}&per_page=100&page=1`,
      'event=pull_request&per_page=100&page=1',
      `head_sha=${sha}&event=push&per_page=100&page=1`,
      `head_sha=main&event=pull_request&per_page=100&page=1`,
      `head_sha=${sha}&head_sha=${sha}&event=pull_request&per_page=100&page=1`,
      `head_sha=${sha}&event=pull_request&event=pull_request&per_page=100&page=1`,
      `head_sha=${sha}&event=pull_request&per_page=100&page=1&status=completed`,
    ].map((query) => `${prefix}/actions/workflows/290018021/runs?${query}`),
  ]) await assert.rejects(client.get(path), sanitized('candidate_read_path_not_allowed'));
  assert.equal(calls, 0);
});

test('rejects invalid credentials, fetch implementations, and unbounded configuration', () => {
  for (const invalidToken of [undefined, null, '', ' ', ' secret', 'secret ', 'a\tb', 'a\nb', 'a\rb', 'a\0b', 'a\x7fb', 'é', {}, 123]) {
    assert.throws(() => clientWith(async () => Response.json({}), { token: invalidToken }),
      sanitized('candidate_read_config_invalid'));
  }
  for (const fetchImpl of [null, {}, 'fetch']) {
    assert.throws(() => clientWith(fetchImpl), sanitized('candidate_read_config_invalid'));
  }
  for (const option of ['timeoutMs', 'maxBytes']) {
    for (const value of [null, 0, -1, 0.5, NaN, Infinity, '100', Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => clientWith(async () => Response.json({}), { [option]: value }),
        sanitized('candidate_read_config_invalid'));
    }
  }
  for (const options of [undefined, null, [], 1, 'secret']) {
    assert.throws(() => createCandidateReadClient(options), sanitized('candidate_read_config_invalid'));
  }
  assert.throws(() => clientWith(async () => Response.json({}), { timeoutMs: 60_001 }),
    sanitized('candidate_read_config_invalid'));
  assert.throws(() => clientWith(async () => Response.json({}), { maxBytes: 16 * 1024 * 1024 + 1 }),
    sanitized('candidate_read_config_invalid'));
  assert.throws(() => createCandidateReadClient({ get token() { throw new Error(secret); } }),
    sanitized('candidate_read_config_invalid'));
});

test('uses the default fetch only when get is called', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return Response.json({ ok: true }); });
  const client = createCandidateReadClient({ token });
  assert.equal(calls, 0);
  assert.deepEqual(await client.get(commitPath), { ok: true });
  assert.equal(calls, 1);
});

test('sanitizes synchronous throws and asynchronous transport rejections without trusting error codes', async () => {
  for (const fetchImpl of [
    () => { throw new Error(secret, { cause: secret }); },
    async () => { throw Object.assign(new Error(secret), { code: secret }); },
    async () => { throw new CandidateReadRefusal(secret); },
    async () => { throw new CandidateReadRefusal('candidate_read_timeout'); },
    async () => { throw token; },
  ]) {
    await assert.rejects(clientWith(fetchImpl).get(commitPath), sanitized('candidate_read_transport_failed'));
  }
});

test('rejects redirects and HTTP failures without reading their bodies, and cancels them', async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 403, 404, 429, 500]) {
    let read = false;
    let cancelled = false;
    let signal;
    const response = new Response(new ReadableStream({
      pull() { read = true; throw new Error(secret); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status, headers: { Location: `https://attacker.example/${token}` } });
    const client = clientWith(async (url, options) => { signal = options.signal; return response; });
    await assert.rejects(client.get(commitPath), sanitized('candidate_read_http_error'));
    assert.equal(read, false);
    assert.equal(cancelled, true);
    assert.equal(signal.aborted, true);
  }
  const redirected = Response.json({ secret });
  Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(clientWith(async () => redirected).get(commitPath), sanitized('candidate_read_http_error'));
});

test('enforces the byte cap across streamed chunks, even with absent or dishonest content length', async () => {
  for (const headers of [undefined, { 'Content-Length': '2' }]) {
    let cancelled = false;
    let signal;
    const response = streamResponse([Buffer.from('['), Buffer.from('12345'), Buffer.from(']')], {
      headers, cancel() { cancelled = true; },
    });
    const client = clientWith(async (url, options) => { signal = options.signal; return response; }, { maxBytes: 5 });
    await assert.rejects(client.get(commitPath), sanitized('candidate_read_response_too_large'));
    assert.equal(cancelled, true);
    assert.equal(signal.aborted, true);
  }
});

test('rejects an oversized declared body before reading and handles cancellation failure safely', async () => {
  let read = false;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull() { read = true; },
    cancel() { cancelled = true; return Promise.reject(new Error(secret)); },
  }, { highWaterMark: 0 }), { headers: { 'Content-Length': '6' } });
  await assert.rejects(clientWith(async () => response, { maxBytes: 5 }).get(commitPath),
    sanitized('candidate_read_response_too_large'));
  assert.equal(read, false);
  assert.equal(cancelled, true);
});

test('counts UTF-8 bytes and accepts an exact cap with characters split across chunks', async () => {
  const chunks = [Uint8Array.of(34, 0xc3), Uint8Array.of(0xa9, 34)];
  assert.equal(await clientWith(async () => streamResponse(chunks), { maxBytes: 4 }).get(commitPath), 'é');
  await assert.rejects(clientWith(async () => streamResponse(chunks), { maxBytes: 3 }).get(commitPath),
    sanitized('candidate_read_response_too_large'));
});

test('rejects invalid JSON, malformed UTF-8, missing streams, and non-byte chunks safely', async () => {
  for (const response of [
    new Response(secret), new Response(''), new Response(null),
    streamResponse([Uint8Array.of(34, 0xff, 34)]),
    streamResponse([Uint8Array.of(34, 0xc3)]),
    streamResponse(['{}']),
    { status: 200, ok: true, headers: new Headers(), json() { throw new Error(secret); } },
  ]) {
    await assert.rejects(clientWith(async () => response).get(commitPath), sanitized('candidate_read_response_invalid'));
  }
});

test('sanitizes failures while reading a response stream', async () => {
  const response = new Response(new ReadableStream({
    pull(controller) { controller.error(new Error(secret)); },
  }));
  await assert.rejects(clientWith(async () => response).get(commitPath), sanitized('candidate_read_transport_failed'));
});

test('fails closed on malformed content lengths and partial HTTP responses', async () => {
  for (const length of ['-1', '1.5', 'NaN', '2, 2']) {
    const response = new Response('{}', { headers: { 'Content-Length': length } });
    await assert.rejects(clientWith(async () => response).get(commitPath), sanitized('candidate_read_response_invalid'));
  }
  for (const status of [204, 206]) {
    const response = new Response(status === 204 ? null : '{}', { status });
    await assert.rejects(clientWith(async () => response).get(commitPath), sanitized('candidate_read_http_error'));
  }
});

test('defaults to an 8 MiB byte cap and a ten-second abort deadline', async (t) => {
  const response = streamResponse([new Uint8Array(8 * 1024 * 1024 + 1)]);
  await assert.rejects(clientWith(async () => response).get(commitPath), sanitized('candidate_read_response_too_large'));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const client = clientWith((url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const rejected = assert.rejects(client.get(commitPath), sanitized('candidate_read_timeout'));
  t.mock.timers.tick(9999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('enforces the deadline even when immediate empty chunks prevent timers from running', async (t) => {
  let now = 0;
  let cancelled = false;
  t.mock.method(performance, 'now', () => now);
  const response = new Response(new ReadableStream({
    pull(controller) {
      now += 10;
      if (now > 100) controller.error(new Error('Client ignored deadline'));
      else controller.enqueue(new Uint8Array());
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  await assert.rejects(clientWith(async () => response, { timeoutMs: 20 }).get(commitPath),
    sanitized('candidate_read_timeout'));
  assert.equal(cancelled, true);
});

test('times out and aborts fetch even when the transport ignores the signal', { timeout: 2000 }, async () => {
  let signal;
  const client = clientWith((url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, { timeoutMs: 20 });
  await assert.rejects(client.get(commitPath), sanitized('candidate_read_timeout'));
  assert.equal(signal.aborted, true);
});

test('keeps the timeout active during body reads and cancels a stalled stream', { timeout: 2000 }, async () => {
  let cancelled = false;
  let signal;
  const response = new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const client = clientWith(async (url, options) => { signal = options.signal; return response; }, { timeoutMs: 20 });
  await assert.rejects(client.get(commitPath), sanitized('candidate_read_timeout'));
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test('cancels responses that arrive after their request timed out', { timeout: 2000 }, async () => {
  let respond;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const client = clientWith(() => new Promise((resolve) => { respond = resolve; }), { timeoutMs: 20 });
  await assert.rejects(client.get(commitPath), sanitized('candidate_read_timeout'));
  respond(response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('clears finished request timers and isolates simultaneous request signals', { timeout: 2000 }, async () => {
  const signals = [];
  const client = clientWith(async (url, { signal }) => {
    signals.push(signal);
    if (signals.length === 1) return new Promise(() => {});
    return Response.json({ ok: true });
  }, { timeoutMs: 20 });
  const pendingFailure = assert.rejects(client.get(commitPath), sanitized('candidate_read_timeout'));
  assert.deepEqual(await client.get(commitPath), { ok: true });
  await pendingFailure;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
});

test('supports resolveCandidate through the real client with entirely local response fixtures', async () => {
  const repo = 'lawxcompany-stack/Plataforma-LawX';
  const treeSha = 'e'.repeat(40);
  const replies = new Map([
    [`${prefix}/commits/${sha}/pulls?per_page=100&page=1`, [{
      number: 42, state: 'open',
      head: { sha, repo: { full_name: repo, id: 771 } },
      base: { ref: 'preview', sha: '1'.repeat(40), repo: { full_name: repo, id: 771 } },
    }]],
    [`${prefix}/pulls/42/files?per_page=100&page=1`, [{ filename: 'src/example.mjs', status: 'modified' }]],
    [commitPath, { sha, tree: { sha: treeSha } }],
    [`${prefix}/git/trees/${treeSha}?recursive=1`, {
      sha: treeSha, truncated: false, tree: [{ path: 'src/example.mjs', type: 'blob', sha: 'b'.repeat(40) }],
    }],
  ]);
  const api = clientWith(async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    assert.equal(replies.has(path), true);
    return Response.json(replies.get(path));
  });
  const candidate = await resolveCandidate({ api, candidateSha: sha, sourcePins: {
    schema_version: 1, protected_prefixes: [], protected_paths: [], reviewed_blobs: {},
  } });
  assert.equal(candidate.pullNumber, 42);
  assert.equal(candidate.treeSha, treeSha);
  assert.deepEqual(candidate.changedFiles, ['src/example.mjs']);
  assert.deepEqual(candidate.sourceBlobShas, { 'src/example.mjs': 'b'.repeat(40) });
});
