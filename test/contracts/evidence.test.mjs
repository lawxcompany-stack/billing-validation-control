import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseEvidenceArchive } from '../../src/contracts/evidence.mjs';
import { acceptanceDocument, expectedAcceptanceIdentity, makeZip } from '../github/zip-fixture.mjs';

function archiveFor(entries, options) {
  return makeZip(entries, options);
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function jsonEntry(document = acceptanceDocument(), name = 'billing-acceptance.json') {
  return { name, contents: JSON.stringify(document), method: 8 };
}

test('parses the bounded sanitized CI acceptance aggregate without extracting files', () => {
  const archive = archiveFor([jsonEntry()]);
  const parsed = parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedAcceptanceIdentity(),
  });

  assert.deepEqual(parsed, {
    schemaVersion: 1,
    candidateSha: 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13',
    runId: '35810119625',
    attempt: 1,
    ok: true,
    status: 'passed',
    categories: ['quality', 'regression', 'build', 'remote-sql', 'remote-concurrency', 'financial-e2e'],
  });
});

test('rejects a digest mismatch before trusting artifact contents', () => {
  const archive = archiveFor([jsonEntry()]);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: `sha256:${'0'.repeat(64)}`,
    expected: expectedAcceptanceIdentity(),
  }), { code: 'artifact_digest_mismatch' });
});

test('rejects malformed acceptance JSON and schema versions', () => {
  for (const contents of ['{', JSON.stringify(acceptanceDocument({ version: 2 }))]) {
    const archive = archiveFor([{ name: 'billing-acceptance.json', contents }]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'evidence_schema_invalid' });
  }
});

test('rejects unrecognized fields and raw check payloads instead of parsing arbitrary data', () => {
  const archive = archiveFor([jsonEntry(acceptanceDocument({ message: 'untrusted free text' }))]);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedAcceptanceIdentity(),
  }), { code: 'evidence_schema_invalid' });
});

test('rejects a green run summary that contains any non-success raw check conclusion', () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral']) {
    const archive = archiveFor([jsonEntry(acceptanceDocument({
      checks: [{ id: 'forged-check', conclusion }],
    }))]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'evidence_schema_invalid' });
  }
});

test('refuses an empty raw check list instead of letting run-level success override it', () => {
  const archive = archiveFor([jsonEntry(acceptanceDocument({ checks: [] }))]);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedAcceptanceIdentity(),
  }), { code: 'evidence_schema_invalid' });
});

test('rejects a failed aggregate even if other summary fields claim success', () => {
  const failingVariants = [
    { ok: false, status: 'failed', failures: ['quality_not_passed'] },
    { ok: true, status: 'failed', failures: ['quality_not_passed'] },
    { ok: true, status: 'passed', failures: ['quality_not_passed'] },
    { ok: false, status: 'passed', failures: [] },
  ];
  for (const override of failingVariants) {
    const archive = archiveFor([jsonEntry(acceptanceDocument(override))]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'evidence_schema_invalid' });
  }
});

test('rejects incomplete expected categories even when aggregate status is passed', () => {
  const archive = archiveFor([jsonEntry(acceptanceDocument({ categories: [] }))]);
  assert.throws(() => parseEvidenceArchive(archive, {
    digest: digest(archive),
    expected: expectedAcceptanceIdentity(),
  }), { code: 'evidence_schema_invalid' });
});

test('rejects acceptance identity whose candidate, run, or attempt differs', () => {
  const changed = [
    { identity: { candidateSha: 'b'.repeat(40), runId: '35810119625', runAttempt: '1' } },
    { identity: { candidateSha: 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13', runId: '999', runAttempt: '1' } },
    { identity: { candidateSha: 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13', runId: '35810119625', runAttempt: '2' } },
  ];

  for (const override of changed) {
    const archive = archiveFor([jsonEntry(acceptanceDocument(override))]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'evidence_identity_mismatch' });
  }
});

test('rejects path traversal and absolute paths in untrusted ZIP entries', () => {
  for (const name of ['../billing-acceptance.json', '/billing-acceptance.json', 'C:/billing-acceptance.json', 'dir/../../billing-acceptance.json']) {
    const archive = archiveFor([jsonEntry(acceptanceDocument(), name)]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'artifact_path_forbidden' });
  }
});

test('rejects symlinks, special files, executable permissions, and executable filenames', () => {
  const unsafeEntries = [
    [{ name: 'billing-acceptance.json', contents: JSON.stringify(acceptanceDocument()), mode: 0o120777 }],
    [{ name: 'billing-acceptance.json', contents: JSON.stringify(acceptanceDocument()), mode: 0o100755 }],
    [jsonEntry(), { name: 'run.sh', contents: '#!/bin/sh', mode: 0o100644 }],
  ];

  for (const entries of unsafeEntries) {
    const archive = archiveFor(entries);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'artifact_executable_or_special_file' });
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

test('rejects structurally valid encrypted, multi-disk, ZIP64, and overlapping ZIP records', () => {
  const encrypted = archiveFor([{ ...jsonEntry(), encrypted: true }]);
  const multiDisk = archiveFor([jsonEntry()], { disk: 1, centralDisk: 1 });
  const zip64 = archiveFor([{ ...jsonEntry(), zip64Extra: true }]);
  const overlapping = archiveFor([jsonEntry(), jsonEntry()], { overlapLocalRecord: 1 });
  const fixtures = [encrypted, multiDisk, zip64, overlapping];

  for (const archive of fixtures) {
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'artifact_zip_invalid' });
  }
});

test('rejects artifacts unless their sole root file is the exact allowlisted acceptance report', () => {
  for (const name of ['evidence.json', 'nested/billing-acceptance.json', 'billing-acceptance-extra.json']) {
    const archive = archiveFor([jsonEntry(acceptanceDocument(), name)]);
    assert.throws(() => parseEvidenceArchive(archive, {
      digest: digest(archive),
      expected: expectedAcceptanceIdentity(),
    }), { code: 'artifact_member_not_allowlisted' });
  }
});
