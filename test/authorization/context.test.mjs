import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { authorizationFixture } from './fixtures.mjs';
import { authorizationApiFixture, ROOT, WORKFLOW } from './task2-fixtures.mjs';

const module = await import('../../src/authorization/context.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
function required() { assert.ok(module, 'Task2 context reader is not implemented'); return module; }
const invalid = { code: 'authorization_context_invalid' };

// Only the internal GET seam maps fixed public selectors to this loopback server.
// Native fetch owns decoding, stream errors and cancellation, as in production.
async function localContextApi(t, { encoding = 'gzip', encode = gzipSync, declaredLength,
  send = (response, wire) => response.end(wire) } = {}) {
  const api = authorizationApiFixture();
  const requests = []; const responses = [];
  const server = createServer((request, response) => {
    const suffix = request.url === '/' ? '' : request.url;
    if (!Object.hasOwn(api.payloads, suffix)) { response.writeHead(404); response.end(); return; }
    const decoded = Buffer.from(JSON.stringify(api.payloads[suffix]));
    const wire = encode(decoded);
    requests.push({ suffix, decodedBytes: decoded.length, wireBytes: wire.length });
    const headers = { 'content-type': 'application/json', connection: 'close',
      'content-length': declaredLength ?? String(wire.length) };
    if (encoding !== null) headers['content-encoding'] = encoding;
    response.writeHead(200, headers);
    send(response, wire);
  });
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    server.removeAllListeners();
    assert.equal(server.listening, false);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { ...api, requests, responses, async get(url, options) {
    assert.ok(url.startsWith(ROOT));
    const suffix = url.slice(ROOT.length);
    assert.ok(Object.hasOwn(api.payloads, suffix), `unexpected endpoint ${suffix}`);
    api.calls.push({ url, options });
    const response = await fetch(`${origin}${suffix || '/'}`, options);
    responses.push(response);
    return response;
  } };
}

for (const [encoding, encode] of [
  ['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync],
  [' GZip\t', gzipSync], [' BR ', brotliCompressSync], [' DeFlAtE ', deflateSync],
  ['identity', (bytes) => bytes], [' IdEnTiTy\t', (bytes) => bytes], [null, (bytes) => bytes],
]) {
  test(`local HTTP ${JSON.stringify(encoding)} completes all seven context reads`, { timeout: 5_000 }, async (t) => {
    const { readAuthorizationContextWithDependencies: read } = required();
    const api = await localContextApi(t, { encoding, encode });
    const result = await read({ manifest: authorizationFixture(), get: api.get });
    assert.deepEqual(result, { controlSha: 'd'.repeat(40), runId: '567890123', runAttempt: '2',
      workflowId: '901234567', jobs: [
        { name: 'authorize', jobId: '801234560' }, { name: 'reader', jobId: '801234561' },
        { name: 'attest-activation', jobId: '801234562' },
      ] });
    assert.ok(Object.isFrozen(result));
    assert.equal(api.requests.length, 7);
    assert.deepEqual(api.requests.map(({ suffix }) => suffix), ['', api.runPath, api.attemptPath,
      '/actions/workflows/authorize-local-collector.yml', `${api.attemptPath}/jobs?per_page=100&page=1`,
      '/branches/main', api.runPath]);
    if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
      // Compression can coincidentally preserve a small payload's length. The
      // first response must differ to reproduce the original refusal at GET 1.
      assert.notEqual(api.requests[0].wireBytes, api.requests[0].decodedBytes);
    }
    for (const { url, options } of api.calls) {
      assert.ok(url.startsWith(ROOT));
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent', 'X-GitHub-Api-Version']);
      assert.equal(options.signal.aborted, false);
    }
  });
}

for (const decodedBytes of [65_536, 65_537]) {
  test(`local HTTP gzip enforces the decoded byte limit at ${decodedBytes}`, { timeout: 5_000 }, async (t) => {
    const { readAuthorizationContextWithDependencies: read } = required();
    const api = await localContextApi(t);
    api.payloads[''].padding = '';
    api.payloads[''].padding = 'x'.repeat(decodedBytes - Buffer.byteLength(JSON.stringify(api.payloads[''])));
    const pending = read({ manifest: authorizationFixture(), get: api.get });
    if (decodedBytes === 65_536) {
      assert.equal((await pending).runId, '567890123');
      assert.equal(api.requests.length, 7);
    } else {
      await assert.rejects(pending, invalid);
      assert.equal(api.requests.length, 1);
      assert.equal(api.calls[0].options.signal.aborted, true);
    }
    assert.equal(api.requests[0].decodedBytes, decodedBytes);
    assert.ok(api.requests[0].wireBytes < 1_024);
  });
}

test('local HTTP truncated gzip transfer fails through the native stream before the deadline', { timeout: 5_000 }, async (t) => {
  const { readAuthorizationContextWithDependencies: read } = required();
  const api = await localContextApi(t, { send(response, wire) {
    response.write(wire.subarray(0, wire.length - 8));
    response.socket.end(); // Close the transport before the declared wire length is delivered.
  } });
  await assert.rejects(read({ manifest: authorizationFixture(), get: api.get }), invalid);
  assert.equal(api.requests.length, 1);
  assert.equal(api.responses.length, 1); // Headers arrived; the real body stream failed.
  assert.equal(api.responses[0].bodyUsed, true);
  assert.equal(api.calls[0].options.signal.aborted, true);
  assert.equal(api.calls[0].options.signal.reason.code, 'authorization_context_invalid');
});

test('local HTTP gzip checksum errors fail closed through native decompression', { timeout: 5_000 }, async (t) => {
  const { readAuthorizationContextWithDependencies: read } = required();
  const api = await localContextApi(t, { encode(bytes) {
    const wire = gzipSync(bytes);
    wire[wire.length - 8] ^= 0xff; // Corrupt CRC32 without changing the HTTP content length.
    return wire;
  } });
  await assert.rejects(read({ manifest: authorizationFixture(), get: api.get }), invalid);
  assert.equal(api.requests.length, 1);
  assert.equal(api.calls[0].options.signal.aborted, true);
  assert.equal(api.calls[0].options.signal.reason.code, 'authorization_context_invalid');
});

for (const declaredLength of ['65537', '01', '-1', 'invalid']) {
  test(`local HTTP gzip refuses invalid declared length ${declaredLength}`, { timeout: 5_000 }, async (t) => {
    const { readAuthorizationContextWithDependencies: read } = required();
    const api = await localContextApi(t, { declaredLength });
    await assert.rejects(read({ manifest: authorizationFixture(), get: api.get }), invalid);
    assert.equal(api.requests.length, 1);
    assert.equal(api.calls[0].options.signal.aborted, true);
  });
}

for (const encoding of ['compress', 'zstd', '', 'g zip', 'gzip; q=1', 'identity, identity']) {
  test(`local HTTP refuses unsupported or malformed encoding ${JSON.stringify(encoding)}`, { timeout: 5_000 }, async (t) => {
    const { readAuthorizationContextWithDependencies: read } = required();
    const api = await localContextApi(t, { encoding, encode: (bytes) => bytes });
    await assert.rejects(read({ manifest: authorizationFixture(), get: api.get }), invalid);
    assert.equal(api.requests.length, 1);
    assert.equal(api.calls[0].options.signal.aborted, true);
  });
}

test('local HTTP refuses chained gzip and br even when native fetch can decode them', { timeout: 5_000 }, async (t) => {
  const { readAuthorizationContextWithDependencies: read } = required();
  const api = await localContextApi(t, { encoding: 'gzip, br', encode: (bytes) => brotliCompressSync(gzipSync(bytes)) });
  await assert.rejects(read({ manifest: authorizationFixture(), get: api.get }), invalid);
  assert.equal(api.requests.length, 1);
  assert.equal(api.calls[0].options.signal.aborted, true);
});

test('identity and absent encoding retain exact declared length checks at the reader boundary', async () => {
  const { readAuthorizationContextWithDependencies: read } = required();
  // Native HTTP validates framing itself. These boundary cases also prove the
  // reader retains its own check when a transport supplies inconsistent headers.
  for (const encoding of [null, 'identity', ' IdEnTiTy\t']) {
    for (const difference of [-1, 1]) {
      const api = authorizationApiFixture();
      await assert.rejects(read({ manifest: authorizationFixture(), get: async (url, options) => {
        const response = await api.get(url, options);
        if (api.calls.length === 1) {
          response.headers.set('content-length', String(Buffer.byteLength(JSON.stringify(api.payloads[''])) + difference));
          if (encoding !== null) response.headers.set('content-encoding', encoding);
        }
        return response;
      } }), invalid);
      assert.equal(api.calls.length, 1);
      assert.equal(api.calls[0].options.signal.aborted, true);
    }
  }
});

test('compressed responses retain declared length syntax and size guards at the reader boundary', async () => {
  const { readAuthorizationContextWithDependencies: read } = required();
  // Native HTTP may reject malformed framing first. Supply valid decoded
  // metadata here so a missing reader guard cannot hide behind transport or JSON errors.
  for (const declaredLength of ['65537', '9007199254740992', '01', '-1', '1.0', 'invalid', '']) {
    const api = authorizationApiFixture();
    await assert.rejects(read({ manifest: authorizationFixture(), get: async (url, options) => {
      const response = await api.get(url, options);
      response.headers.set('content-encoding', 'gzip');
      response.headers.set('content-length', declaredLength);
      return response;
    } }), invalid);
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].options.signal.aborted, true);
  }
});

test('completed current/exact attempt, three hosted jobs and protected current main yield a frozen snapshot', async () => {
  const { readAuthorizationContextWithDependencies: read } = required();
  const manifest = authorizationFixture();
  const api = authorizationApiFixture(manifest);
  const result = await read({ manifest, get: api.get });
  assert.equal(result.controlSha, manifest.control.sha);
  assert.equal(result.runId, '567890123');
  assert.equal(result.runAttempt, '2');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.jobs));
  assert.equal(api.calls.length, 7);
  assert.equal(api.calls.at(-1).url, `${ROOT}${api.runPath}`);
  for (const { url, options } of api.calls) {
    assert.ok(url.startsWith(`${ROOT}`));
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent', 'X-GitHub-Api-Version']);
    assert.equal(options.signal.aborted, false);
  }
});

for (const [name, mutate] of [
  ['successful old attempt after rerun', (a) => { a.payloads[a.runPath].run_attempt = 3; }],
  ['old exact attempt', (a) => { a.payloads[a.attemptPath].run_attempt = 1; }],
  ['wrong run', (a) => { a.payloads[a.runPath].id++; }],
  ['current run cancelled', (a) => { a.payloads[a.runPath].conclusion = 'cancelled'; }],
  ['attempt still running', (a) => { a.payloads[a.attemptPath].status = 'in_progress'; }],
  ['wrong control ID', (a) => { a.payloads[a.runPath].repository.id++; }],
  ['wrong control name', (a) => { a.payloads[a.runPath].repository.full_name = 'evil/control'; }],
  ['fork head ID', (a) => { a.payloads[a.runPath].head_repository.id++; }],
  ['fork head name', (a) => { a.payloads[a.runPath].head_repository.full_name = 'evil/control'; }],
  ['wrong run SHA', (a) => { a.payloads[a.runPath].head_sha = 'e'.repeat(40); }],
  ['wrong branch', (a) => { a.payloads[a.runPath].head_branch = 'other'; }],
  ['wrong event', (a) => { a.payloads[a.runPath].event = 'pull_request'; }],
  ['wrong workflow path', (a) => { a.payloads[a.runPath].path = '.github/workflows/validate-billing.yml'; }],
  ['workflow ID mismatch', (a) => { a.payloads[a.attemptPath].workflow_id++; }],
  ['workflow definition mismatch', (a) => { a.payloads['/actions/workflows/authorize-local-collector.yml'].path = 'evil.yml'; }],
  ['repository renamed', (a) => { a.payloads[''].name = 'other'; }],
  ['repository identity changed', (a) => { a.payloads[''].id++; }],
  ['repository default branch changed', (a) => { a.payloads[''].default_branch = 'other'; }],
  ['private repository', (a) => { a.payloads[''].private = true; }],
  ['main advanced', (a) => { a.payloads['/branches/main'].commit.sha = 'e'.repeat(40); }],
  ['unprotected main', (a) => { a.payloads['/branches/main'].protected = false; }],
  ['branch endpoint wrong name', (a) => { a.payloads['/branches/main'].name = 'other'; }],
]) {
  test(`context refuses ${name}`, async () => {
    const { readAuthorizationContextWithDependencies: read } = required();
    const api = authorizationApiFixture(); mutate(api);
    await assert.rejects(read({ manifest: authorizationFixture(), get: api.get }), invalid);
  });
}

for (const [name, mutate] of [
  ['missing job', (p) => { p.jobs.pop(); }], ['extra job', (p) => { p.jobs.push({ ...p.jobs[0], id: 999 }); }],
  ['duplicate ID', (p) => { p.jobs[1].id = p.jobs[0].id; }],
  ['duplicate name', (p) => { p.jobs[1].name = p.jobs[0].name; }],
  ['wrong run', (p) => { p.jobs[0].run_id++; }], ['wrong attempt', (p) => { p.jobs[0].run_attempt++; }],
  ['wrong SHA', (p) => { p.jobs[0].head_sha = 'e'.repeat(40); }],
  ['failed job', (p) => { p.jobs[0].conclusion = 'failure'; }],
  ['queued job', (p) => { p.jobs[0].status = 'queued'; }],
  ['self hosted', (p) => { p.jobs[0].labels = ['self-hosted', 'ubuntu-latest']; }],
  ['unknown hosted label', (p) => { p.jobs[0].labels = ['ubuntu-24.04']; }],
  ['unsafe ID', (p) => { p.jobs[0].id = Number.MAX_SAFE_INTEGER + 1; }],
  ['pagination count', (p) => { p.total_count = 4; }],
]) {
  test(`context refuses jobs with ${name}`, async () => {
    const { readAuthorizationContextWithDependencies: read } = required();
    const api = authorizationApiFixture();
    mutate(api.payloads[`${api.attemptPath}/jobs?per_page=100&page=1`]);
    await assert.rejects(read({ manifest: authorizationFixture(), get: api.get }), invalid);
  });
}

test('final current-run read catches a rerun that started while reading jobs', async () => {
  const { readAuthorizationContextWithDependencies: read } = required();
  const api = authorizationApiFixture();
  await assert.rejects(read({ manifest: authorizationFixture(), get: async (url, options) => {
    if (url.endsWith('/branches/main')) api.payloads[api.runPath].run_attempt = 3;
    return api.get(url, options);
  } }), invalid);
});

test('context snapshots manifest selectors before the first await', async () => {
  const { readAuthorizationContextWithDependencies: read } = required();
  const manifest = authorizationFixture(); const api = authorizationApiFixture();
  const result = await read({ manifest, get: (url, options) => {
    manifest.control.runId = '999'; manifest.control.sha = 'f'.repeat(40);
    return api.get(url, options);
  } });
  assert.equal(result.runId, '567890123');
  assert.equal(result.controlSha, 'd'.repeat(40));
});

test('workflow path may use the documented @main suffix and jobs may arrive out of order', async () => {
  const { readAuthorizationContextWithDependencies: read } = required();
  const api = authorizationApiFixture();
  for (const endpoint of [api.runPath, api.attemptPath]) api.payloads[endpoint].path = `${WORKFLOW}@main`;
  api.payloads[`${api.attemptPath}/jobs?per_page=100&page=1`].jobs.reverse();
  const result = await read({ manifest: authorizationFixture(), get: api.get });
  assert.deepEqual(result.jobs.map((job) => job.name), ['authorize', 'reader', 'attest-activation']);
});

test('GET refuses redirects, HTTP failures, pagination, malformed or oversized bodies', async () => {
  const { readAuthorizationContextWithDependencies: read } = required();
  for (const response of [
    new Response('{}', { status: 302, headers: { location: 'https://evil.invalid' } }),
    Response.json({}, { status: 404 }), Response.json({}, { headers: { link: '<bad>; rel="next"' } }),
    new Response('{bad', { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    Response.json({}, { headers: { 'content-length': '9999999' } }),
    new Response(' '.repeat(65_537), { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
  ]) await assert.rejects(read({ manifest: authorizationFixture(), get: async () => response }), invalid);
});

test('GET and streaming-body deadlines work even when the double ignores AbortSignal', async (t) => {
  const { readAuthorizationContextWithDependencies: read } = required();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const body of [false, true]) {
    const promise = read({ manifest: authorizationFixture(), get: () => {
      queueMicrotask(() => t.mock.timers.tick(3_001));
      return body ? new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }),
        { headers: { 'content-type': 'application/json' } }) : new Promise(() => {});
    } });
    await assert.rejects(promise, invalid);
  }
});

test('aborted and historical requests and public injection refuse before GET', async () => {
  const { readAuthorizationContextWithDependencies: read, readAuthorizationContext: publicRead } = required();
  let calls = 0; const get = async () => { calls++; throw new Error('private value'); };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(read({ manifest: authorizationFixture(), get, signal: controller.signal }), invalid);
  await assert.rejects(publicRead({ manifest: authorizationFixture(), get }), invalid);
  const manifest = { ...authorizationFixture(), operation: 'recover', sourceExecutionId: '2'.repeat(32) };
  await assert.rejects(read({ manifest, get }), { code: 'authorization_operation_unsupported' });
  assert.equal(calls, 0);
});

test('public context refuses extra positional arguments before GET', async (t) => {
  const { readAuthorizationContext } = required(); let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; throw new Error('must not execute'); });
  await assert.rejects(readAuthorizationContext({ manifest: authorizationFixture() }, { get: () => {} }), invalid);
  assert.equal(calls, 0);
});

test('a refused HTTP response cancels the transport instead of leaving a response in flight', async () => {
  const { readAuthorizationContextWithDependencies: read } = required(); let signal;
  await assert.rejects(read({ manifest: authorizationFixture(), get: async (_url, options) => {
    signal = options.signal;
    return Response.json({}, { status: 503 });
  } }), invalid);
  assert.equal(signal.aborted, true);
});
