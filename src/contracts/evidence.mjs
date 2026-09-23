import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const EVIDENCE_ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 8 * 1024 * 1024,
  totalUncompressedBytes: 4 * 1024 * 1024,
  evidenceJsonBytes: 1024 * 1024,
  fileCount: 32,
  checkCount: 100,
});

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP64_EXTRA = 0x0001;
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'schema_version', 'candidate_sha', 'workflow_id', 'run_id', 'run_attempt', 'suite', 'checks',
]);
const ALLOWED_CHECK_KEYS = new Set(['id', 'conclusion', 'code']);
const CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'skipped', 'neutral']);

export class EvidenceRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'EvidenceRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new EvidenceRefusal(code);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertRange(buffer, offset, length, limit, code = 'artifact_zip_invalid') {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > limit) {
    refuse(code);
  }
}

function readName(bytes) {
  let name;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    refuse('artifact_zip_invalid');
  }
  if (!name || name.includes('\0') || name.includes('\\') || /[\u0000-\u001f\u007f]/u.test(name)) {
    refuse('artifact_path_forbidden');
  }
  const segments = name.split('/');
  if (name.startsWith('/') || /^[a-z]:/iu.test(name) || segments.some((part) => part === '.' || part === '..')) {
    refuse('artifact_path_forbidden');
  }
  return name;
}

function rejectZip64(extra, offset, length) {
  let cursor = offset;
  const end = offset + length;
  while (cursor < end) {
    assertRange(extra, cursor, 4, end);
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    cursor += 4;
    assertRange(extra, cursor, size, end);
    if (id === ZIP64_EXTRA) refuse('artifact_zip_invalid');
    cursor += size;
  }
  if (cursor !== end) refuse('artifact_zip_invalid');
}

function findEndRecord(archive) {
  const minOffset = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= minOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== ZIP_EOCD) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  refuse('artifact_zip_invalid');
}

function parseDirectory(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 22) refuse('artifact_zip_invalid');
  if (archive.length > EVIDENCE_ARCHIVE_LIMITS.archiveBytes) refuse('artifact_too_large');

  const eocdOffset = findEndRecord(archive);
  const disk = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const diskCount = archive.readUInt16LE(eocdOffset + 8);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskCount !== entryCount || entryCount === 0 ||
      entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
      entryCount > EVIDENCE_ARCHIVE_LIMITS.fileCount || centralOffset + centralSize !== eocdOffset) {
    refuse('artifact_zip_invalid');
  }

  const entries = [];
  let cursor = centralOffset;
  let declaredTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(archive, cursor, 46, eocdOffset);
    if (archive.readUInt32LE(cursor) !== ZIP_CENTRAL) refuse('artifact_zip_invalid');
    const madeBy = archive.readUInt16LE(cursor + 4) >>> 8;
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const startDisk = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    assertRange(archive, cursor + 46, nameLength + extraLength + commentLength, eocdOffset);
    if (startDisk !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
        localOffset === 0xffffffff || (flags & ~(0x0008 | 0x0800)) !== 0 ||
        (flags & 0x0001) !== 0 || ![0, 8].includes(method)) {
      refuse('artifact_zip_invalid');
    }
    const name = readName(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    rejectZip64(archive, cursor + 46 + nameLength, extraLength);
    const unixMode = madeBy === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    const fileType = unixMode & 0o170000;
    if ((fileType !== 0 && fileType !== 0o100000) || (unixMode & 0o111) !== 0 ||
        /\.(?:sh|bash|zsh|command|exe|dll|so|dylib|bat|cmd|ps1|py|pyc|js|mjs|cjs|wasm)$/iu.test(name)) {
      refuse('artifact_executable_or_special_file');
    }
    if (name.endsWith('/')) refuse('artifact_member_not_allowlisted');
    declaredTotal += uncompressedSize;
    if (declaredTotal > EVIDENCE_ARCHIVE_LIMITS.totalUncompressedBytes ||
        uncompressedSize > EVIDENCE_ARCHIVE_LIMITS.evidenceJsonBytes) refuse('artifact_uncompressed_too_large');
    entries.push({ name, flags, method, checksum, compressedSize, uncompressedSize, localOffset });
    cursor = recordEnd;
  }
  if (cursor !== eocdOffset) refuse('artifact_zip_invalid');

  const occupied = [];
  for (const entry of entries) {
    assertRange(archive, entry.localOffset, 30, centralOffset);
    if (archive.readUInt32LE(entry.localOffset) !== ZIP_LOCAL) refuse('artifact_zip_invalid');
    const flags = archive.readUInt16LE(entry.localOffset + 6);
    const method = archive.readUInt16LE(entry.localOffset + 8);
    const localChecksum = archive.readUInt32LE(entry.localOffset + 14);
    const localCompressedSize = archive.readUInt32LE(entry.localOffset + 18);
    const localUncompressedSize = archive.readUInt32LE(entry.localOffset + 22);
    const nameLength = archive.readUInt16LE(entry.localOffset + 26);
    const extraLength = archive.readUInt16LE(entry.localOffset + 28);
    const headerEnd = entry.localOffset + 30 + nameLength + extraLength;
    assertRange(archive, entry.localOffset + 30, nameLength + extraLength, centralOffset);
    const localName = readName(archive.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength));
    rejectZip64(archive, entry.localOffset + 30 + nameLength, extraLength);
    if (localName !== entry.name || flags !== entry.flags || method !== entry.method ||
        ((flags & 0x0008) === 0 && (localChecksum !== entry.checksum ||
          localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize))) {
      refuse('artifact_zip_invalid');
    }
    const dataEnd = headerEnd + entry.compressedSize;
    assertRange(archive, headerEnd, entry.compressedSize, centralOffset);
    let recordEnd = dataEnd;
    if ((flags & 0x0008) !== 0) {
      let descriptorOffset = dataEnd;
      if (descriptorOffset + 4 <= centralOffset && archive.readUInt32LE(descriptorOffset) === 0x08074b50) descriptorOffset += 4;
      assertRange(archive, descriptorOffset, 12, centralOffset);
      if (archive.readUInt32LE(descriptorOffset) !== entry.checksum ||
          archive.readUInt32LE(descriptorOffset + 4) !== entry.compressedSize ||
          archive.readUInt32LE(descriptorOffset + 8) !== entry.uncompressedSize) refuse('artifact_zip_invalid');
      recordEnd = descriptorOffset + 12;
    }
    occupied.push([entry.localOffset, recordEnd]);
    entry.dataOffset = headerEnd;
  }
  occupied.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < occupied.length; index += 1) {
    if (occupied[index][0] < occupied[index - 1][1]) refuse('artifact_zip_invalid');
  }
  return entries;
}

function decodeEntry(archive, entry) {
  const compressed = archive.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let contents;
  try {
    contents = entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: EVIDENCE_ARCHIVE_LIMITS.evidenceJsonBytes });
  } catch {
    refuse('artifact_zip_invalid');
  }
  if (contents.length !== entry.uncompressedSize || crc32(contents) !== entry.checksum) refuse('artifact_zip_invalid');
  return contents;
}

function parseDocument(contents) {
  let document;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
  } catch {
    refuse('evidence_schema_invalid');
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document) ||
      Object.keys(document).some((key) => !ALLOWED_TOP_LEVEL_KEYS.has(key)) ||
      Object.keys(document).length !== ALLOWED_TOP_LEVEL_KEYS.size || document.schema_version !== 1 ||
      typeof document.candidate_sha !== 'string' || !/^[0-9a-f]{40}$/u.test(document.candidate_sha) ||
      !Number.isSafeInteger(document.workflow_id) || document.workflow_id < 1 ||
      typeof document.run_id !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(document.run_id) ||
      !Number.isSafeInteger(document.run_attempt) || document.run_attempt < 1 || document.run_attempt > 20 ||
      typeof document.suite !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/u.test(document.suite) ||
      !Array.isArray(document.checks) || document.checks.length === 0 ||
      document.checks.length > EVIDENCE_ARCHIVE_LIMITS.checkCount) {
    refuse('evidence_schema_invalid');
  }

  const seen = new Set();
  const checks = document.checks.map((check) => {
    if (check === null || typeof check !== 'object' || Array.isArray(check) ||
        Object.keys(check).some((key) => !ALLOWED_CHECK_KEYS.has(key)) ||
        Object.keys(check).length !== ALLOWED_CHECK_KEYS.size ||
        typeof check.id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,79}$/u.test(check.id) ||
        seen.has(check.id) || !CONCLUSIONS.has(check.conclusion) ||
        typeof check.code !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,79}$/u.test(check.code)) {
      refuse('evidence_schema_invalid');
    }
    seen.add(check.id);
    return Object.freeze({ id: check.id, conclusion: check.conclusion, code: check.code });
  });
  return Object.freeze({
    schemaVersion: document.schema_version,
    candidateSha: document.candidate_sha,
    workflowId: document.workflow_id,
    runId: document.run_id,
    attempt: document.run_attempt,
    suite: document.suite,
    checks: Object.freeze(checks),
  });
}

export function parseEvidenceArchive(archive, { digest, expected } = {}) {
  if (!Buffer.isBuffer(archive)) refuse('artifact_zip_invalid');
  if (archive.length > EVIDENCE_ARCHIVE_LIMITS.archiveBytes) refuse('artifact_too_large');
  const actualDigest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest) || digest !== actualDigest) {
    refuse('artifact_digest_mismatch');
  }
  const entries = parseDirectory(archive);
  if (entries.length !== 1 || entries[0].name !== 'evidence.json') {
    refuse('artifact_member_not_allowlisted');
  }
  const evidence = parseDocument(decodeEntry(archive, entries[0]));
  const identity = expected ?? {};
  if (evidence.candidateSha !== identity.candidateSha || evidence.workflowId !== identity.workflowId ||
      evidence.runId !== String(identity.runId) || evidence.attempt !== identity.attempt || evidence.suite !== identity.suite) {
    refuse('evidence_identity_mismatch');
  }
  return evidence;
}
