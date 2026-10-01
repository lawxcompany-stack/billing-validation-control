import { generateKeyPairSync, sign } from 'node:crypto';
import { databasePolicy } from './standalone-fixture.mjs';

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
  schema_version: 3,
  environment: 'billing-validation',
  vercel: Object.freeze({ projectId: 'prj_lawxvalidation', teamId: 'team_lawxvalidation' }),
  database: databasePolicy,
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
      const bytes = Buffer.from(JSON.stringify(document), 'utf8');
      return { ok: true, status: 200,
        headers: { get(name) {
          if (name.toLowerCase() === 'content-type') return 'application/json';
          if (name.toLowerCase() === 'content-length') return String(bytes.byteLength);
          return null;
        } },
        body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        async json() { return document; } };
    },
  };
}
