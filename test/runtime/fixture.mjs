import { generateKeyPairSync, sign } from 'node:crypto';

const keyPair = generateKeyPairSync('ed25519');
export const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });

export const candidate = Object.freeze({
  candidateSha: 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13',
  treeSha: 'dddddddddddddddddddddddddddddddddddddddd',
});

export const deployment = Object.freeze({
  id: 'dpl_candidate123',
  origin: 'https://lawx-abc123def-team.vercel.app',
});

export const policy = Object.freeze({
  schema_version: 1,
  environment: 'billing-validation',
  vercel: Object.freeze({ projectId: 'prj_lawxvalidation', teamId: 'team_lawxvalidation' }),
  database: Object.freeze({
    projectRef: 'abcdefghijklmnopqrst',
    branchId: 'synthetic-billing-validation',
    branchName: 'synthetic-validation-branch',
  }),
  stripe: Object.freeze({ accountId: 'acct_testlawx123', webhookEndpointId: 'we_testlawx123', livemode: false }),
  attestation: Object.freeze({ publicKeyPem }),
});

export function signedAttestation({ timestamp, overrides = {} } = {}) {
  const payload = {
    origin: deployment.origin,
    deploymentId: deployment.id,
    commit: candidate.candidateSha,
    treeHash: candidate.treeSha,
    env: 'billing-validation',
    projectRef: policy.database.projectRef,
    timestamp: timestamp ?? new Date().toISOString(),
    ...overrides,
  };
  const signature = sign(null, Buffer.from(JSON.stringify(payload), 'utf8'), keyPair.privateKey).toString('base64');
  return { ...payload, signature };
}

export function fetchFixture(document) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return { ok: true, status: 200, async json() { return document; } };
    },
  };
}
