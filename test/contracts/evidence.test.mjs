import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseEvidenceArchive } from '../../src/contracts/evidence.mjs';
import { evidenceDocument, expectedEvidenceIdentity, makeZip } from '../github/zip-fixture.mjs';

function archiveFor(entries, options) {
  return makeZip(entries, options);
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function jsonEntry(document = evidenceDocument(), name = 'evidence.json') {
  return { name, contents: JSON.stringify(document), method: 8 };
}

test('parses only the bounded allowlisted evidence JSON without extracting files', () => {
  const archive = archiveFor([jsonEntry()]);
  const parsed = parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedEvidenceIdentity(),
  });

  assert.deepEqual(parsed, {
    schemaVersion: 1,
    candidateSha: 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13',
    workflowId: 290018021,
    runId: '35810119625',
    attempt: 1,
    suite: 'ci',
    checks: [{ id: 'billing-contract', conclusion: 'success', code: 'observed' }],
  });
});

test('rejects a digest mismatch before trusting artifact contents', () => {
  const archive = archiveFor([jsonEntry()]);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: `sha256:${'0'.repeat(64)}`,
    expected: expectedEvidenceIdentity(),
  }), { code: 'artifact_digest_mismatch' });
});

test('rejects malformed evidence JSON and schema versions', () => {
  for (const contents of ['{', JSON.stringify(evidenceDocument({ schema_version: 2 }))]) {
    const archive = archiveFor([{ name: 'evidence.json', contents }]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedEvidenceIdentity(),
    }), { code: 'evidence_schema_invalid' });
  }
});

test('rejects unrecognized evidence fields instead of parsing arbitrary payloads', () => {
  const archive = archiveFor([jsonEntry(evidenceDocument({ message: 'untrusted free text' }))]);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedEvidenceIdentity(),
  }), { code: 'evidence_schema_invalid' });
});

test('rejects evidence whose candidate, workflow, run, attempt, or suite identity differs', () => {
  const changed = [
    { candidate_sha: 'b'.repeat(40) },
    { workflow_id: 123 },
    { run_id: '999' },
    { run_attempt: 2 },
    { suite: 'other' },
  ];

  for (const override of changed) {
    const archive = archiveFor([jsonEntry(evidenceDocument(override))]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedEvidenceIdentity(),
    }), { code: 'evidence_identity_mismatch' });
  }
});

test('rejects path traversal and absolute paths in untrusted ZIP entries', () => {
  for (const name of ['../evidence.json', '/evidence.json', 'C:/evidence.json', 'dir/../../evidence.json']) {
    const archive = archiveFor([jsonEntry(evidenceDocument(), name)]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedEvidenceIdentity(),
    }), { code: 'artifact_path_forbidden' });
  }
});

test('rejects symlinks, special files, executable permissions, and executable filenames', () => {
  const unsafeEntries = [
    [{ name: 'evidence.json', contents: JSON.stringify(evidenceDocument()), mode: 0o120777 }],
    [{ name: 'evidence.json', contents: JSON.stringify(evidenceDocument()), mode: 0o100755 }],
    [jsonEntry(), { name: 'run.sh', contents: '#!/bin/sh', mode: 0o100644 }],
  ];

  for (const entries of unsafeEntries) {
    const archive = archiveFor(entries);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedEvidenceIdentity(),
    }), { code: 'artifact_executable_or_special_file' });
  }
});

test('rejects extra, duplicate, and excessive files in the archive', () => {
  const cases = [
    [jsonEntry(), { name: 'notes.txt', contents: 'not allowlisted' }],
    [jsonEntry(), jsonEntry(evidenceDocument(), 'evidence.json')],
    Array.from({ length: 65 }, (_, index) => ({ name: `file-${index}.json`, contents: '{}' })),
  ];

  for (const entries of cases) {
    const archive = archiveFor(entries);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedEvidenceIdentity(),
    }));
  }
});

test('rejects oversized archives before parsing their directory', () => {
  const archive = Buffer.alloc(8 * 1024 * 1024 + 1);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: 'sha256:' + '0'.repeat(64),
    expected: expectedEvidenceIdentity(),
  }), { code: 'artifact_too_large' });
});

test('rejects malformed, encrypted, multi-disk, ZIP64, or overlapping ZIP structures', () => {
  const malformed = [Buffer.from('PK\x03\x04'), Buffer.alloc(22)];
  for (const archive of malformed) {
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedEvidenceIdentity(),
    }), { code: 'artifact_zip_invalid' });
  }
});
