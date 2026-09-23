import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function makeZip(entries, {
  comment = Buffer.alloc(0),
  disk = 0,
  centralDisk = 0,
  overlapLocalRecord = -1,
} = {}) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [index, entry] of entries.entries()) {
    const name = Buffer.from(entry.name, 'utf8');
    const contents = Buffer.isBuffer(entry.contents) ? entry.contents : Buffer.from(entry.contents ?? '');
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(contents) : contents;
    const crc = crc32(contents);
    const encryptedHeader = Buffer.alloc(12);
    encryptedHeader.writeUInt32LE(0x12345678, 0);
    encryptedHeader.writeUInt32LE(0x90abcdef, 4);
    encryptedHeader[11] = crc >>> 24;
    const encryptedPayload = entry.encrypted ? Buffer.concat([encryptedHeader, compressed]) : compressed;
    const localFlags = 0x0800 | (entry.encrypted ? 0x0001 : 0);
    const centralFlags = 0x0800 | (entry.encrypted ? 0x0001 : 0);
    const mode = entry.mode ?? 0o100644;
    const zip64Extra = entry.zip64Extra
      ? Buffer.from([0x01, 0x00, 0x10, 0x00, ...u64(contents.length), ...u64(compressed.length)])
      : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.zip64Extra ? 45 : 20, 4);
    local.writeUInt16LE(localFlags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.zip64Extra ? 0xffffffff : encryptedPayload.length, 18);
    local.writeUInt32LE(entry.zip64Extra ? 0xffffffff : contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(zip64Extra.length, 28);
    localParts.push(local, name, zip64Extra, encryptedPayload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | (entry.zip64Extra ? 45 : 20), 4);
    central.writeUInt16LE(entry.zip64Extra ? 45 : 20, 6);
    central.writeUInt16LE(centralFlags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.zip64Extra ? 0xffffffff : encryptedPayload.length, 20);
    central.writeUInt32LE(entry.zip64Extra ? 0xffffffff : contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(zip64Extra.length, 30);
    central.writeUInt16LE(entry.diskStart ?? disk, 34);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(index === overlapLocalRecord ? 0 : localOffset, 42);
    centralParts.push(central, name, zip64Extra);
    localOffset += local.length + name.length + zip64Extra.length + encryptedPayload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralOffset = localOffset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(disk, 4);
  end.writeUInt16LE(centralDisk, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...localParts, centralDirectory, end, comment]);
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return [...bytes];
}

export const ACCEPTANCE_CATEGORIES = Object.freeze([
  'quality', 'regression', 'build', 'remote-sql', 'remote-concurrency', 'financial-e2e',
]);

export const FINAL_ACCEPTANCE_TREE_HASH = 'b'.repeat(40);

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function finalAcceptanceDocument(overrides = {}) {
  const candidateSha = 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13';
  const provenance = {
    source: 'github-actions',
    synthetic: false,
    runId: '35810119625',
    runAttempt: '1',
    repository: 'lawxcompany-stack/Plataforma-LawX',
  };
  const artifacts = ['lint', 'typecheck', 'coverage', 'build', 'sql', 'browser', 'stripe', 'webhook', 'worker']
    .map((kind, index) => ({
      kind,
      candidateSha,
      treeHash: FINAL_ACCEPTANCE_TREE_HASH,
      sha256: String(index + 1).repeat(64),
      collectedAt: '2026-09-23T02:20:00.000Z',
      provenance: { ...provenance },
      evidence: index < 5
        ? { job: `${kind}-job`, reportKind: kind === 'sql' ? 'billing-remote' : kind, bytes: 128 }
        : {
          receiptCount: 2,
          sources: [1, 2].map((sequence) => ({
            sequence, receiptCount: 1, sha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
          })),
        },
    }));
  const manifest = {
    version: 1,
    kind: 'billing-final-acceptance',
    status: 'passed',
    candidate: { sha: candidateSha, treeHash: FINAL_ACCEPTANCE_TREE_HASH },
    database: {
      projectRef: 'abcdefghijklmnopqrst',
      branchId: 'billing-validation-2026',
      migrationDigest: 'a'.repeat(64),
      migrationDigestScope: 'reviewed-assets',
      bootstrap: {
        binding: 'baseline-seed-acl-and-migration-versions',
        receiptSha256: 'b'.repeat(64),
        projectRef: 'abcdefghijklmnopqrst',
        schemaDigest: 'c'.repeat(64),
        completedAt: '2026-09-23T01:59:00.000Z',
        appliedVersionCount: 3,
        jobReportSha256: 'd'.repeat(64),
      },
    },
    deployment: {
      id: 'dpl_candidate123', origin: 'https://billing-candidate.vercel.app',
      sha: candidateSha, treeHash: FINAL_ACCEPTANCE_TREE_HASH,
    },
    stripe: { accountId: 'acct_testlawx123', livemode: false },
    webhook: {
      endpoint: 'https://billing-candidate.vercel.app/api/stripe/webhook',
      livemode: false,
      id: 'we_testendpoint123',
    },
    artifacts,
    replayRuns: [1, 2].map((sequence) => ({
      sequence,
      status: 'passed',
      startedAt: '2026-09-23T02:00:00.000Z',
      finishedAt: '2026-09-23T02:10:00.000Z',
      scenarioCount: 12,
      scenarioDigest: 'e'.repeat(64),
      cleanupDigest: 'f'.repeat(64),
      manifestSha256: '1'.repeat(64),
      manifestBytes: 1024,
      receiptDigest: '2'.repeat(64),
      provenance: {
        ...provenance,
        fixtureRunId: `fixture-${sequence}`,
        manifestPath: sequence === 1 ? 'manifest.json' : 'replay-2/manifest.json',
      },
    })),
    generatedAt: '2026-09-23T02:20:00.000Z',
    replayVerification: { scope: 'independent-scenario-completion', businessOutcomeEquivalence: 'not-evaluated' },
    financialReport: {
      job: 'financial-e2e', sha256: '3'.repeat(64), bytes: 256, githubOutputSha256: '4'.repeat(64),
    },
    ...overrides,
  };
  if (overrides.candidate) manifest.candidate = { sha: candidateSha, treeHash: FINAL_ACCEPTANCE_TREE_HASH, ...overrides.candidate };
  const unsigned = { ...manifest };
  delete unsigned.manifestDigest;
  manifest.manifestDigest = Object.hasOwn(overrides, 'manifestDigest')
    ? overrides.manifestDigest
    : createHash('sha256').update(canonicalJson(unsigned), 'utf8').digest('hex');
  return manifest;
}

export function acceptanceDocument(overrides = {}) {
  return {
    version: 1,
    identity: {
      candidateSha: 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13',
      runId: '35810119625',
      runAttempt: '1',
    },
    ok: true,
    status: 'passed',
    categories: [...ACCEPTANCE_CATEGORIES],
    failures: [],
    ...overrides,
  };
}

export function expectedAcceptanceIdentity(overrides = {}) {
  return {
    candidateSha: 'afd8955bf0b1332aa1c6c220a8267e2a7e6c0f13',
    candidateTree: FINAL_ACCEPTANCE_TREE_HASH,
    ...overrides,
  };
}
