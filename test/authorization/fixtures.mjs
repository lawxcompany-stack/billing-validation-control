// Synthetic schema fixtures only; these values are not reviewed release pins.
import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID } from '../../src/contracts/control-identity.mjs';

export function authorizationFixture() {
  return {
    schemaVersion: 2,
    kind: 'billing-collector-authorization',
    executionMode: 'isolated-local',
    operation: 'collect',
    executionId: '11111111111111111111111111111111',
    activationCommitment: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    candidate: {
      repository: 'lawxcompany-stack/Plataforma-LawX',
      repositoryId: '1234079266',
      pullNumber: '123',
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      treeSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      baseSha: 'cccccccccccccccccccccccccccccccccccccccc',
    },
    prerequisites: {
      workflowId: '290018021',
      workflowPath: '.github/workflows/ci.yml',
      runId: '345678901',
      runAttempt: '1',
      jobs: [
        { key: 'quality', jobId: '456789012', conclusion: 'success' },
        { key: 'regression', jobId: '456789013', conclusion: 'success' },
        { key: 'build', jobId: '456789014', conclusion: 'success' },
      ],
    },
    control: {
      repository: CONTROL_REPOSITORY,
      repositoryId: CONTROL_REPOSITORY_ID,
      ref: 'refs/heads/main',
      workflowPath: '.github/workflows/authorize-local-collector.yml',
      sha: 'dddddddddddddddddddddddddddddddddddddddd',
      runId: '567890123',
      runAttempt: '2',
      event: 'workflow_dispatch',
    },
    collectorRelease: {
      image: 'ghcr.io/lawxcompany-stack/billing-validation-control@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      configDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      sourceSha: '1111111111111111111111111111111111111111',
      sourceTreeSha: '2222222222222222222222222222222222222222',
      policyDigest: '3333333333333333333333333333333333333333333333333333333333333333',
    },
    policy: {
      environmentDigest: '4444444444444444444444444444444444444444444444444444444444444444',
      contractsDigest: '5555555555555555555555555555555555555555555555555555555555555555',
      egressDigest: '6666666666666666666666666666666666666666666666666666666666666666',
      limitsDigest: '7777777777777777777777777777777777777777777777777777777777777777',
    },
    suite: 'billing-43',
    issuedAt: '2026-09-29T12:00:00.000Z',
    expiresAt: '2026-09-29T12:20:00.000Z',
    sourceExecutionId: null,
  };
}
