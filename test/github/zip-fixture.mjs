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
    const encryptedPayload = entry.encrypted ? Buffer.concat([Buffer.alloc(12), compressed]) : compressed;
    const crc = crc32(contents);
    const flags = 0x0800 | (entry.encrypted ? 0x0001 : 0);
    const mode = entry.mode ?? 0o100644;
    const zip64Extra = entry.zip64Extra
      ? Buffer.from([0x01, 0x00, 0x10, 0x00, ...u64(contents.length), ...u64(compressed.length)])
      : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.zip64Extra ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
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
    central.writeUInt16LE(flags, 8);
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
    runId: '35810119625',
    attempt: 1,
    categories: [...ACCEPTANCE_CATEGORIES],
    ...overrides,
  };
}
