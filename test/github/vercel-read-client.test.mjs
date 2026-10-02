import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVercelReadClient } from '../../src/github/vercel-read-client.mjs';

const candidateSha = 'a'.repeat(40);
const projectId = 'prj_lawxvalidation';
const teamId = 'team_lawxvalidation';
const token = 'read-only-vercel-token-fixture';

function createClient(fetchImpl) {
  return createVercelReadClient({ token, candidateSha, projectId, teamId, fetchImpl });
}

test('Vercel reader sends only fixed API GETs with redirects and implicit credentials disabled', async () => {
  const calls = [];
  const client = createClient(async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ready: true });
  });
  const query = new URLSearchParams({
    projectId, teamId, target: 'preview', sha: candidateSha, state: 'READY', limit: '20',
  });
  assert.deepEqual(await client.get(`/v7/deployments?${query}`), { ready: true });
  assert.deepEqual(await client.get(`/v13/deployments/dpl_candidate123?withGitRepoInfo=true&teamId=${teamId}`), { ready: true });
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.ok(url.startsWith('https://api.vercel.com/'));
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
  }
});

test('Vercel reader refuses any API route outside the exact preview list and detail routes', async () => {
  let calls = 0;
  const client = createClient(async () => {
    calls += 1;
    return Response.json({});
  });
  for (const path of [
    '/v7/deployments?projectId=prj_other&target=production',
    '/v13/deployments/dpl_candidate123?withGitRepoInfo=true&teamId=team_other',
    '/v13/deployments/dpl_candidate123?withGitRepoInfo=true&teamId=team_lawxvalidation&extra=1',
    'https://attacker.invalid/v7/deployments',
  ]) await assert.rejects(client.get(path), { code: 'vercel_read_path_not_allowed' });
  assert.equal(calls, 0);
});

test('Vercel reader fails closed on redirects, HTTP errors, and oversized response bodies', async () => {
  const listPath = `/v7/deployments?${new URLSearchParams({
    projectId, teamId, target: 'preview', sha: candidateSha, state: 'READY', limit: '20',
  })}`;
  const redirected = createClient(async () => Response.redirect('https://attacker.invalid/steal', 302));
  await assert.rejects(redirected.get(listPath), { code: 'vercel_read_http_error' });

  const failed = createClient(async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(failed.get(listPath), { code: 'vercel_read_http_error' });

  const oversized = createClient(async () => new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 }));
  await assert.rejects(oversized.get(listPath), { code: 'vercel_read_response_too_large' });
});

test('Vercel reader refuses malformed or missing read-only token configuration before fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({});
  };
  for (const invalid of [
    { candidateSha, projectId, teamId, fetchImpl },
    { token: '', candidateSha, projectId, teamId, fetchImpl },
    { token, candidateSha: 'not-a-sha', projectId, teamId, fetchImpl },
    { token, candidateSha, projectId, teamId, fetchImpl, extra: 'forbidden' },
  ]) assert.throws(() => createVercelReadClient(invalid), { code: 'vercel_read_config_invalid' });
  assert.equal(calls, 0);
});
