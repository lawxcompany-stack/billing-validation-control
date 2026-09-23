import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseEvidenceArchive } from '../../src/contracts/evidence.mjs';
import {
  acceptanceDocument,
  expectedAcceptanceIdentity,
  finalAcceptanceDocument,
  makeZip,
} from '../github/zip-fixture.mjs';

function archiveFor(entries, options) {
  return makeZip(entries, options);
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalProducerJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalProducerJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalProducerJson(value[key])}`).join(',')}}`;
}

function resealProducerDocument(document) {
  delete document.manifestDigest;
  document.manifestDigest = createHash('sha256').update(canonicalProducerJson(document), 'utf8').digest('hex');
  return document;
}

function archiveForMutation(mutate) {
  const document = structuredClone(finalAcceptanceDocument());
  mutate(document);
  return archiveFor([jsonEntry(resealProducerDocument(document))]);
}

function assertRejectedManifest(archive, code = 'evidence_schema_invalid') {
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedAcceptanceIdentity(),
  }), { code });
}

function jsonEntry(document = finalAcceptanceDocument(), name = 'billing-acceptance.json') {
  return { name, contents: JSON.stringify(document), method: 8 };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
  }
  return value;
}

test('parses the sealed final producer manifest into a minimal projection', () => {
  const document = finalAcceptanceDocument();
  assert.equal(document.manifestDigest, '8da953c72340020fb8a2aa5592f4ad58063dd7939606a0a1381940aabac5c873');
  const archive = archiveFor([jsonEntry(document)]);
  const parsed = parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedAcceptanceIdentity(),
  });

  assert.deepEqual(parsed, {
    schemaVersion: 1,
    kind: 'billing-final-acceptance',
    candidateSha: 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13',
    candidateTree: 'b'.repeat(40),
    status: 'passed',
    manifestDigest: document.manifestDigest,
  });
  assert.match(document.replayIndexSha256, /^[0-9a-f]{64}$/u);
  for (const field of [
    'database', 'deployment', 'stripe', 'webhook', 'artifacts', 'replayRuns',
    'replayVerification', 'financialReport', 'replayIndexSha256',
  ]) {
    assert.equal(Object.hasOwn(parsed, field), false, `projection must not expose ${field}`);
  }
});

test('requires every producer root field even when a missing-field manifest is resealed', () => {
  for (const field of [
    'database', 'deployment', 'stripe', 'webhook', 'artifacts', 'replayRuns',
    'generatedAt', 'replayVerification', 'financialReport', 'replayIndexSha256',
  ]) {
    assertRejectedManifest(archiveForMutation((document) => { delete document[field]; }));
  }
});

test('rejects malformed producer root containers and cardinalities after resealing', () => {
  const malformed = [
    (document) => { document.database = []; },
    (document) => { document.deployment = null; },
    (document) => { document.stripe = 'test'; },
    (document) => { document.webhook = []; },
    (document) => { document.artifacts = {}; },
    (document) => { document.artifacts.pop(); },
    (document) => { document.replayRuns = {}; },
    (document) => { document.replayRuns.pop(); },
    (document) => { document.generatedAt = 123; },
    (document) => { document.replayVerification = []; },
    (document) => { document.financialReport = false; },
    (document) => { document.replayIndexSha256 = 'A'.repeat(64); },
    (document) => { document.replayIndexSha256 = '5'.repeat(63); },
  ];
  for (const mutate of malformed) assertRejectedManifest(archiveForMutation(mutate));
});

test('rejects missing producer-critical nested structures after resealing', () => {
  const incomplete = [
    (document) => { delete document.database.bootstrap; },
    (document) => { delete document.database.migrationArtifacts; },
    (document) => { document.database.bootstrap = []; },
    (document) => { document.database.migrationArtifacts = {}; },
    (document) => { document.deployment.treeHash = undefined; },
    (document) => { document.deployment.treeHash = null; },
    (document) => { delete document.stripe.accountId; },
    (document) => { delete document.webhook.endpoint; },
    (document) => { delete document.artifacts[0].provenance; },
    (document) => { delete document.artifacts[0].evidence; },
    (document) => { document.artifacts[0].evidence = []; },
    (document) => { delete document.replayRuns[0].provenance; },
    (document) => { delete document.replayRuns[0].scenarioDigest; },
    (document) => { delete document.replayVerification.scope; },
    (document) => { delete document.financialReport.githubOutputSha256; },
  ];
  for (const mutate of incomplete) assertRejectedManifest(archiveForMutation(mutate));
});

test('rejects resealed manifests with producer environment identities outside app constraints', () => {
  const malformed = [
    (document) => { document.database.projectRef = 'Abcdefghijklmnopqrst'; },
    (document) => { document.database.projectRef = 'abcdefghijklmnopqrs'; },
    (document) => { document.database.projectRef = 'abcdefghijklmnopqr!t'; },
    (document) => { document.database.branchId = 'ab'; },
    (document) => { document.database.branchId = '_billing-validation'; },
    (document) => { document.database.branchId = 'billing/validation'; },
    (document) => { document.database.branchId = 'billing-validation\n'; },
    (document) => { document.database.branchId = 'a'.repeat(129); },
    (document) => { document.deployment.id = 'deploy_candidate123'; },
    (document) => { document.deployment.id = 'dpl_candidate-123'; },
    (document) => { document.deployment.id = 'dpl_candidate123\n'; },
    (document) => { document.deployment.origin = 'http://billing-candidate.vercel.app'; },
    (document) => { document.deployment.origin = 'https://billing-candidate.vercel.app/'; },
    (document) => { document.deployment.origin = 'https://billing-candidate.vercel.app/path'; },
    (document) => { document.deployment.origin = 'https://billing-candidate.vercel.app?query=1'; },
    (document) => { document.deployment.origin = 'https://billing-candidate.vercel.app:8443'; },
    (document) => { document.deployment.origin = 'https://preview.billing-candidate.vercel.app'; },
    (document) => { document.deployment.sha = 'c'.repeat(40); },
    (document) => { document.deployment.treeHash = 'd'.repeat(40); },
    (document) => { document.stripe.accountId = 'acct_test-lawx'; },
    (document) => { document.stripe.accountId = 'acct_testlawx\n'; },
    (document) => { document.stripe.livemode = true; },
    (document) => { document.webhook.livemode = true; },
    (document) => { document.webhook.endpoint = 'https://other.vercel.app/api/stripe/webhook'; },
  ];

  for (const mutate of malformed) assertRejectedManifest(archiveForMutation(mutate));
});

test('rejects resealed manifests whose Supabase bootstrap and migration fingerprints are inconsistent', () => {
  const malformed = [
    (document) => { document.database.bootstrap.projectRef = 'zyxwvutsrqponmlkjihg'; },
    (document) => { document.database.migrationDigestScope = 'all-migrations'; },
    (document) => { document.database.schemaFingerprintVersion = 2; },
    (document) => { document.database.observedSchemaDigest = 'd'.repeat(64); },
    (document) => { delete document.database.observedSchemaDigest; },
    (document) => { delete document.database.schemaFingerprintVersion; },
    (document) => { delete document.database.bootstrap.schemaFingerprintVersion; },
    (document) => { document.database.migrationDigest = '0'.repeat(64); },
    (document) => { document.database.migrationArtifacts[0].bytes += 1; },
    (document) => {
      document.database.migrationArtifacts.reverse();
      document.database.migrationDigest = createHash('sha256')
        .update(canonicalProducerJson(document.database.migrationArtifacts), 'utf8').digest('hex');
    },
  ];
  for (const mutate of malformed) assertRejectedManifest(archiveForMutation(mutate));
});

test('accepts a producer manifest with the entire optional schema fingerprint group absent', () => {
  const archive = archiveForMutation((document) => {
    delete document.database.schemaFingerprintVersion;
    delete document.database.observedSchemaDigest;
    delete document.database.bootstrap.schemaFingerprintVersion;
  });
  assert.doesNotThrow(() => parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedAcceptanceIdentity(),
  }));
});

test('binds manifest environment identities to trusted expected values without exposing them', () => {
  const mismatches = [
    [(document) => {
      document.database.projectRef = 'zyxwvutsrqponmlkjihg';
      document.database.bootstrap.projectRef = 'zyxwvutsrqponmlkjihg';
    }, 'zyxwvutsrqponmlkjihg'],
    [(document) => { document.database.branchId = 'other-validation-branch'; }, 'other-validation-branch'],
    [(document) => { document.deployment.id = 'dpl_othercandidate123'; }, 'dpl_othercandidate123'],
    [(document) => {
      document.deployment.origin = 'https://other-billing-candidate.vercel.app';
      document.webhook.endpoint = `${document.deployment.origin}/api/stripe/webhook`;
    }, 'https://other-billing-candidate.vercel.app'],
    [(document) => { document.stripe.accountId = 'acct_othertestaccount'; }, 'acct_othertestaccount'],
  ];

  for (const [mutate, untrustedValue] of mismatches) {
    const archive = archiveForMutation(mutate);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), (error) => {
      assert.equal(error.code, 'evidence_identity_mismatch');
      assert.equal(error.message, 'evidence_identity_mismatch');
      assert.equal(error.message.includes(untrustedValue), false);
      return true;
    });
  }
});

test('rejects a webhook endpoint that differs from the expected test deployment route', () => {
  const archive = archiveForMutation((document) => {
    document.webhook.endpoint = 'https://other-billing-candidate.vercel.app/api/stripe/webhook';
  });
  assertRejectedManifest(archive, 'evidence_schema_invalid');
});

test('rejects missing or malformed expected environment identities', () => {
  const expectedEnvironment = expectedAcceptanceIdentity().environment;
  const invalidEnvironments = [
    undefined,
    null,
    {},
    { ...expectedEnvironment, extra: 'not-allowed' },
    { ...expectedEnvironment, database: { projectRef: 'bad', branchId: 'billing-validation-2026' } },
    { ...expectedEnvironment, deployment: { id: 'dpl_candidate123', origin: 'http://billing-candidate.vercel.app' } },
    { ...expectedEnvironment, stripe: { accountId: 'acct_test-lawx' } },
  ];
  const archive = archiveFor([jsonEntry()]);

  for (const environment of invalidEnvironments) {
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity({ environment }),
    }), { code: 'evidence_identity_invalid' });
  }
});

test('verifies producer canonical JSON independent of object key insertion order', () => {
  const reordered = reverseObjectKeys(finalAcceptanceDocument());
  const archive = archiveFor([jsonEntry(reordered)]);
  assert.doesNotThrow(() => parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedAcceptanceIdentity(),
  }));
});

test('rejects the intermediate aggregate rather than treating it as final acceptance', () => {
  const archive = archiveFor([jsonEntry(acceptanceDocument())]);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedAcceptanceIdentity(),
  }), { code: 'evidence_schema_invalid' });
});

test('rejects wrong final-manifest kind, status, shape, and unsupported root fields', () => {
  const variants = [
    finalAcceptanceDocument({ kind: 'billing-acceptance' }),
    finalAcceptanceDocument({ status: 'failed' }),
    finalAcceptanceDocument({ version: 2 }),
    finalAcceptanceDocument({ candidate: { treeHash: undefined } }),
    finalAcceptanceDocument({ unreviewedField: 'must not be projected' }),
  ];
  for (const document of variants) {
    const archive = archiveFor([jsonEntry(document)]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'evidence_schema_invalid' });
  }
});

test('rejects malformed or mismatched producer manifest seals', () => {
  for (const manifestDigest of ['not-a-digest', '0'.repeat(64)]) {
    const archive = archiveFor([jsonEntry(finalAcceptanceDocument({ manifestDigest }))]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'evidence_manifest_digest_invalid' });
  }
});

test('binds both candidate commit SHA and tree SHA to the resolved Preview candidate', () => {
  const variants = [
    finalAcceptanceDocument({ candidate: { sha: 'c'.repeat(40) } }),
    finalAcceptanceDocument({ candidate: { treeHash: 'd'.repeat(40) } }),
  ];
  for (const document of variants) {
    const archive = archiveFor([jsonEntry(document)]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'evidence_identity_mismatch' });
  }
});

test('requires the expected candidate tree identity to be a full Git SHA', () => {
  const archive = archiveFor([jsonEntry()]);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedAcceptanceIdentity({ candidateTree: 'bad-tree' }),
  }), { code: 'evidence_identity_invalid' });
});

test('rejects a GitHub artifact digest mismatch before trusting its contents', () => {
  const archive = archiveFor([jsonEntry()]);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: `sha256:${'0'.repeat(64)}`,
    expected: expectedAcceptanceIdentity(),
  }), { code: 'artifact_digest_mismatch' });
});

test('rejects malformed JSON', () => {
  const archive = archiveFor([{ name: 'billing-acceptance.json', contents: '{' }]);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedAcceptanceIdentity(),
  }), { code: 'evidence_schema_invalid' });
});

test('rejects path traversal and absolute paths in untrusted ZIP entries', () => {
  for (const name of ['../billing-acceptance.json', '/billing-acceptance.json', 'C:/billing-acceptance.json', 'dir/../../billing-acceptance.json']) {
    const archive = archiveFor([jsonEntry(finalAcceptanceDocument(), name)]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'artifact_path_forbidden' });
  }
});

test('rejects symlinks, special files, executable permissions, and executable filenames', () => {
  const unsafeEntries = [
    [{ name: 'billing-acceptance.json', contents: JSON.stringify(finalAcceptanceDocument()), mode: 0o120777 }],
    [{ name: 'billing-acceptance.json', contents: JSON.stringify(finalAcceptanceDocument()), mode: 0o100755 }],
    [jsonEntry(), { name: 'run.sh', contents: '#!/bin/sh', mode: 0o100644 }],
  ];
  for (const entries of unsafeEntries) {
    const archive = archiveFor(entries);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }));
  }
});

test('rejects extra, duplicate, and excessive files in the archive', () => {
  const cases = [
    [jsonEntry(), { name: 'notes.txt', contents: 'not allowlisted' }],
    [jsonEntry(), jsonEntry()],
    Array.from({ length: 65 }, (_, index) => ({ name: `file-${index}.json`, contents: '{}' })),
  ];
  for (const entries of cases) {
    const archive = archiveFor(entries);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }));
  }
});

test('rejects oversized archives before parsing their directory', () => {
  const archive = Buffer.alloc(8 * 1024 * 1024 + 1);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: 'sha256:' + '0'.repeat(64),
    expected: expectedAcceptanceIdentity(),
  }), { code: 'artifact_too_large' });
});

test('rejects unsupported encryption, nonzero multi-disk metadata, ZIP64 metadata, and overlapping local offsets', () => {
  const encrypted = archiveFor([{ ...jsonEntry(), encrypted: true }]);
  const nonzeroMultiDiskMetadata = archiveFor([jsonEntry()], { disk: 1, centralDisk: 1 });
  const zip64Metadata = archiveFor([{ ...jsonEntry(), zip64Extra: true }]);
  const overlappingLocalOffsets = archiveFor([jsonEntry(), jsonEntry()], { overlapLocalRecord: 1 });
  for (const archive of [encrypted, nonzeroMultiDiskMetadata, zip64Metadata, overlappingLocalOffsets]) {
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'artifact_zip_invalid' });
  }
});

test('requires the sole archive member to be the exact allowlisted root report', () => {
  for (const name of ['evidence.json', 'nested/billing-acceptance.json', 'billing-acceptance-extra.json']) {
    const archive = archiveFor([jsonEntry(finalAcceptanceDocument(), name)]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'artifact_member_not_allowlisted' });
  }
});
