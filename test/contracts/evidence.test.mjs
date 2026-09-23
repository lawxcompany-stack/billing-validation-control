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
  assert.equal(document.manifestDigest, 'e64ee59970062f4926ec8d1bd9db4a091ad1aa0fab37b0ac43b7d75ff1343f4a');
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
  for (const field of ['database', 'deployment', 'stripe', 'webhook', 'artifacts', 'replayRuns', 'financialReport']) {
    assert.equal(Object.hasOwn(parsed, field), false, `projection must not expose ${field}`);
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
