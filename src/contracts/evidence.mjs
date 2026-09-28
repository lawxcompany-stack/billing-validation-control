import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const EVIDENCE_ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 8 * 1024 * 1024,
  totalUncompressedBytes: 4 * 1024 * 1024,
  evidenceJsonBytes: 1024 * 1024,
  fileCount: 32,
});

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP64_EXTRA = 0x0001;
const REQUIRED_FINAL_MANIFEST_KEYS = [
  'version', 'kind', 'status', 'candidate', 'database', 'deployment', 'stripe', 'webhook',
  'artifacts', 'replayRuns', 'generatedAt', 'replayVerification', 'financialReport',
  'replayIndexSha256', 'manifestDigest',
];
const ALLOWED_FINAL_MANIFEST_KEYS = new Set(REQUIRED_FINAL_MANIFEST_KEYS);
const FINAL_ARTIFACT_KINDS = Object.freeze([
  'lint', 'typecheck', 'coverage', 'build', 'sql', 'browser', 'stripe', 'webhook', 'worker',
]);
const SIMPLE_ARTIFACT_REPORTS = Object.freeze({
  lint: 'quality', typecheck: 'quality', coverage: 'regression', build: 'build', sql: 'billing-remote',
});
const DATABASE_PROJECT_REF = /^[a-z0-9]{20}$/u;
const DATABASE_BRANCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/u;
const DEPLOYMENT_HOSTNAME = /^[a-z0-9-]+\.vercel\.app$/u;
const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9_]+$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasStrings(value, keys) {
  return isObject(value) && keys.every((key) => isNonemptyString(value[key]));
}

function validProducerProvenance(value, includeReplayIdentity = false) {
  return hasStrings(value, ['runId', 'runAttempt', 'repository', 'source']) &&
    value.source === 'github-actions' && value.synthetic === false &&
    (!includeReplayIdentity || hasStrings(value, ['fixtureRunId', 'manifestPath']));
}

function validMigrationArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length < 5) return false;
  let previousPath;
  for (const item of artifacts) {
    if (!hasStrings(item, ['path', 'sha256']) || !SHA256.test(item.sha256) || !isCount(item.bytes) ||
        (previousPath !== undefined && previousPath >= item.path)) return false;
    previousPath = item.path;
  }
  return true;
}

function validBootstrap(bootstrap) {
  return hasStrings(bootstrap, [
    'binding', 'receiptSha256', 'projectRef', 'schemaDigest', 'completedAt', 'jobReportSha256',
  ]) && ['receiptSha256', 'schemaDigest', 'jobReportSha256'].every((key) => SHA256.test(bootstrap[key])) &&
    isCount(bootstrap.appliedVersionCount) &&
    (bootstrap.schemaFingerprintVersion === undefined || bootstrap.schemaFingerprintVersion === 1);
}

function validDeploymentOrigin(value) {
  if (!isNonemptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && DEPLOYMENT_HOSTNAME.test(url.hostname);
  } catch {
    return false;
  }
}

export function isValidExpectedEnvironment(environment) {
  return hasExactKeys(environment, ['database', 'deployment', 'stripe']) &&
    hasExactKeys(environment.database, ['projectRef', 'branchId']) &&
    typeof environment.database.projectRef === 'string' && DATABASE_PROJECT_REF.test(environment.database.projectRef) &&
    typeof environment.database.branchId === 'string' && DATABASE_BRANCH_ID.test(environment.database.branchId) &&
    hasExactKeys(environment.deployment, ['id', 'origin']) &&
    typeof environment.deployment.id === 'string' && DEPLOYMENT_ID.test(environment.deployment.id) &&
    validDeploymentOrigin(environment.deployment.origin) &&
    hasExactKeys(environment.stripe, ['accountId']) &&
    typeof environment.stripe.accountId === 'string' && STRIPE_ACCOUNT_ID.test(environment.stripe.accountId);
}

function validArtifactEvidence(kind, evidence) {
  if (!isObject(evidence)) return false;
  if (Object.hasOwn(SIMPLE_ARTIFACT_REPORTS, kind)) {
    return hasStrings(evidence, ['job', 'reportKind']) && evidence.reportKind === SIMPLE_ARTIFACT_REPORTS[kind] &&
      isCount(evidence.bytes);
  }
  return isCount(evidence.receiptCount) && evidence.receiptCount > 0 &&
    Array.isArray(evidence.sources) && evidence.sources.length === 2 &&
    evidence.sources.every((source, index) => source?.sequence === index + 1 && isCount(source.receiptCount) &&
      source.receiptCount > 0 && typeof source.sha256 === 'string' && SHA256.test(source.sha256) &&
      typeof source.manifestSha256 === 'string' && SHA256.test(source.manifestSha256));
}

function validFinalProducerShape(document) {
  const { candidate, database, deployment, stripe, webhook, artifacts, replayRuns } = document;
  if (!isObject(database) || !hasStrings(database, ['projectRef', 'branchId', 'migrationDigest', 'migrationDigestScope']) ||
      !DATABASE_PROJECT_REF.test(database.projectRef) || !DATABASE_BRANCH_ID.test(database.branchId) ||
      !SHA256.test(database.migrationDigest) || database.migrationDigestScope !== 'reviewed-assets' ||
      !validBootstrap(database.bootstrap) || database.bootstrap.projectRef !== database.projectRef ||
      !validMigrationArtifacts(database.migrationArtifacts) ||
      (database.branchName !== undefined && !isNonemptyString(database.branchName)) ||
      (database.observedSchemaDigest !== undefined && !SHA256.test(database.observedSchemaDigest)) ||
      (database.schemaFingerprintVersion !== undefined && database.schemaFingerprintVersion !== 1)) return false;

  const fingerprintGroupAbsent = database.schemaFingerprintVersion === undefined &&
    database.observedSchemaDigest === undefined && database.bootstrap.schemaFingerprintVersion === undefined;
  const fingerprintGroupValid = database.schemaFingerprintVersion === 1 &&
    database.bootstrap.schemaFingerprintVersion === 1 && SHA256.test(database.observedSchemaDigest) &&
    database.observedSchemaDigest === database.bootstrap.schemaDigest;
  if (!fingerprintGroupAbsent && !fingerprintGroupValid) return false;
  if (database.migrationDigest !== createHash('sha256')
    .update(canonicalJson(database.migrationArtifacts), 'utf8').digest('hex')) return false;

  if (!hasStrings(deployment, ['id', 'origin', 'sha', 'treeHash']) || !DEPLOYMENT_ID.test(deployment.id) ||
      !validDeploymentOrigin(deployment.origin) ||
      !FULL_SHA.test(deployment.sha) || !FULL_SHA.test(deployment.treeHash) ||
      deployment.sha !== candidate.sha || deployment.treeHash !== candidate.treeHash) return false;
  if (!hasStrings(stripe, ['accountId']) || !STRIPE_ACCOUNT_ID.test(stripe.accountId) || stripe.livemode !== false) return false;
  if (!hasStrings(webhook, ['endpoint']) || webhook.endpoint !== `${deployment.origin}/api/stripe/webhook` ||
      webhook.livemode !== false ||
      (webhook.id !== undefined && !isNonemptyString(webhook.id)) ||
      (webhook.window !== undefined && !isObject(webhook.window))) return false;

  if (!Array.isArray(artifacts) || artifacts.length !== FINAL_ARTIFACT_KINDS.length ||
      new Set(artifacts.map((item) => item?.kind)).size !== FINAL_ARTIFACT_KINDS.length ||
      !FINAL_ARTIFACT_KINDS.every((kind) => artifacts.some((item) => item?.kind === kind)) ||
      !artifacts.every((item) => isObject(item) && item.candidateSha === candidate.sha &&
        item.treeHash === candidate.treeHash && typeof item.sha256 === 'string' && SHA256.test(item.sha256) &&
        isNonemptyString(item.collectedAt) && validProducerProvenance(item.provenance) &&
        validArtifactEvidence(item.kind, item.evidence))) return false;

  if (!Array.isArray(replayRuns) || replayRuns.length !== 2 ||
      !replayRuns.every((run, index) => isObject(run) && run.sequence === index + 1 && run.status === 'passed' &&
        isNonemptyString(run.startedAt) && isNonemptyString(run.finishedAt) && isCount(run.scenarioCount) &&
        typeof run.scenarioDigest === 'string' && SHA256.test(run.scenarioDigest) &&
        typeof run.cleanupDigest === 'string' && SHA256.test(run.cleanupDigest) &&
        typeof run.manifestSha256 === 'string' && SHA256.test(run.manifestSha256) &&
        isCount(run.manifestBytes) && typeof run.receiptDigest === 'string' && SHA256.test(run.receiptDigest) &&
        validProducerProvenance(run.provenance, true))) return false;

  return isNonemptyString(document.generatedAt) && Number.isFinite(Date.parse(document.generatedAt)) &&
    isObject(document.replayVerification) && hasStrings(document.replayVerification, ['scope', 'businessOutcomeEquivalence']) &&
    hasStrings(document.financialReport, ['job', 'sha256', 'githubOutputSha256']) &&
    SHA256.test(document.financialReport.sha256) && SHA256.test(document.financialReport.githubOutputSha256) &&
    isCount(document.financialReport.bytes) && SHA256.test(document.replayIndexSha256);
}

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

function parseDocument(contents, expected) {
  let document;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
  } catch {
    refuse('evidence_schema_invalid');
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document) ||
      Object.keys(document).some((key) => !ALLOWED_FINAL_MANIFEST_KEYS.has(key)) ||
      REQUIRED_FINAL_MANIFEST_KEYS.some((key) => !Object.hasOwn(document, key)) ||
      document.version !== 1 || document.kind !== 'billing-final-acceptance' || document.status !== 'passed' ||
      document.candidate === null || typeof document.candidate !== 'object' || Array.isArray(document.candidate) ||
      Object.keys(document.candidate).length !== 2 ||
      !Object.hasOwn(document.candidate, 'sha') || !Object.hasOwn(document.candidate, 'treeHash') ||
      typeof document.candidate.sha !== 'string' || !FULL_SHA.test(document.candidate.sha) ||
      typeof document.candidate.treeHash !== 'string' || !FULL_SHA.test(document.candidate.treeHash) ||
      typeof document.replayIndexSha256 !== 'string' || !SHA256.test(document.replayIndexSha256) ||
      !validFinalProducerShape(document)) {
    refuse('evidence_schema_invalid');
  }

  if (typeof document.manifestDigest !== 'string' || !SHA256.test(document.manifestDigest)) {
    refuse('evidence_manifest_digest_invalid');
  }
  const { manifestDigest, ...unsigned } = document;
  const calculatedDigest = createHash('sha256').update(canonicalJson(unsigned), 'utf8').digest('hex');
  if (manifestDigest !== calculatedDigest) refuse('evidence_manifest_digest_invalid');

  if (!hasExactKeys(expected, ['candidateSha', 'candidateTree', 'environment']) ||
      typeof expected.candidateSha !== 'string' || !FULL_SHA.test(expected.candidateSha) ||
      typeof expected.candidateTree !== 'string' || !FULL_SHA.test(expected.candidateTree)) {
    refuse('evidence_identity_invalid');
  }
  if (!isValidExpectedEnvironment(expected.environment)) refuse('evidence_identity_invalid');
  if (document.candidate.sha !== expected.candidateSha || document.candidate.treeHash !== expected.candidateTree) {
    refuse('evidence_identity_mismatch');
  }
  if (document.database.projectRef !== expected.environment.database.projectRef ||
      document.database.branchId !== expected.environment.database.branchId ||
      document.deployment.id !== expected.environment.deployment.id ||
      document.deployment.origin !== expected.environment.deployment.origin ||
      document.stripe.accountId !== expected.environment.stripe.accountId ||
      document.webhook.endpoint !== `${expected.environment.deployment.origin}/api/stripe/webhook`) {
    refuse('evidence_identity_mismatch');
  }
  return Object.freeze({
    schemaVersion: document.version,
    kind: document.kind,
    candidateSha: document.candidate.sha,
    candidateTree: document.candidate.treeHash,
    status: document.status,
    manifestDigest,
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
  if (entries.length !== 1 || entries[0].name !== 'billing-acceptance.json') {
    refuse('artifact_member_not_allowlisted');
  }
  const evidence = parseDocument(decodeEntry(archive, entries[0]), expected);
  return evidence;
}
