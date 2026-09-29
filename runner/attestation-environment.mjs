const ATTESTATION_ENVIRONMENT = 'billing-validation-attestation';
const DEPLOYMENT_ENVIRONMENT_OID = '1.3.6.1.4.1.57264.1.23';
const MAX_CERTIFICATE_BYTES = 64 * 1024;

function refuse() { throw new Error('attestation_environment_invalid'); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function readDerNode(bytes, offset, limit = bytes.length) {
  if (!Buffer.isBuffer(bytes) || !Number.isInteger(offset) || !Number.isInteger(limit) ||
      offset < 0 || offset >= limit || limit > bytes.length) refuse();
  const tag = bytes[offset++];
  if ((tag & 0x1f) === 0x1f || offset >= limit) refuse();
  const firstLength = bytes[offset++];
  let length = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const lengthOctets = firstLength & 0x7f;
    if (lengthOctets === 0 || lengthOctets > 4 || offset + lengthOctets > limit || bytes[offset] === 0) refuse();
    length = 0;
    for (let index = 0; index < lengthOctets; index += 1) {
      length = length * 256 + bytes[offset++];
    }
    if (length < 128) refuse();
  }
  if (!Number.isSafeInteger(length) || length < 0 || offset + length > limit) refuse();
  return { tag, contentStart: offset, contentEnd: offset + length, next: offset + length };
}

function derChildren(bytes, parent) {
  const children = [];
  for (let offset = parent.contentStart; offset < parent.contentEnd;) {
    if (children.length >= 4096) refuse();
    const child = readDerNode(bytes, offset, parent.contentEnd);
    children.push(child);
    offset = child.next;
  }
  return children;
}

function base128Integer(bytes, start, end) {
  if (start >= end || bytes[start] === 0x80) refuse();
  let value = 0;
  for (let offset = start; offset < end; offset += 1) {
    const octet = bytes[offset];
    value = value * 128 + (octet & 0x7f);
    if (!Number.isSafeInteger(value)) refuse();
    if ((octet & 0x80) === 0) return { value, next: offset + 1 };
  }
  refuse();
}

function derOid(bytes, node) {
  if (node.tag !== 0x06 || node.contentStart >= node.contentEnd) refuse();
  const subidentifiers = [];
  for (let offset = node.contentStart; offset < node.contentEnd;) {
    if (subidentifiers.length >= 64) refuse();
    const decoded = base128Integer(bytes, offset, node.contentEnd);
    subidentifiers.push(decoded.value);
    offset = decoded.next;
  }
  const first = subidentifiers.shift();
  const firstArc = first < 40 ? 0 : first < 80 ? 1 : 2;
  return [firstArc, first - (firstArc * 40), ...subidentifiers].join('.');
}

function certificateBytes(rawBytes) {
  if (typeof rawBytes !== 'string' || rawBytes.length === 0 || rawBytes.length > MAX_CERTIFICATE_BYTES * 2 ||
      rawBytes.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(rawBytes)) refuse();
  const bytes = Buffer.from(rawBytes, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_CERTIFICATE_BYTES || bytes.toString('base64') !== rawBytes) refuse();
  return bytes;
}

function certificateRawBytes(attestation) {
  const bundle = attestation?.bundle;
  const material = bundle?.verificationMaterial;
  if (!isRecord(bundle) || !isRecord(material)) refuse();

  if (isRecord(material.certificate) && typeof material.certificate.rawBytes === 'string' &&
      material.x509CertificateChain === undefined) return material.certificate.rawBytes;

  const certificates = material.x509CertificateChain?.certificates;
  if (material.certificate === undefined && Array.isArray(certificates) &&
      certificates.length > 0 && certificates.length <= 8 &&
      certificates.every((certificate) => isRecord(certificate) && typeof certificate.rawBytes === 'string')) {
    return certificates[0].rawBytes;
  }
  refuse();
}

function deploymentEnvironmentFromCertificate(rawBytes) {
  const bytes = certificateBytes(rawBytes);
  const certificate = readDerNode(bytes, 0);
  if (certificate.tag !== 0x30 || certificate.next !== bytes.length) refuse();
  const certificateFields = derChildren(bytes, certificate);
  if (certificateFields.length !== 3 || certificateFields[0].tag !== 0x30 ||
      certificateFields[1].tag !== 0x30 || certificateFields[2].tag !== 0x03) refuse();
  const tbsFields = derChildren(bytes, certificateFields[0]);
  const extensionFields = tbsFields.filter((field) => field.tag === 0xa3);
  if (extensionFields.length !== 1) refuse();
  const extensionSequence = derChildren(bytes, extensionFields[0]);
  if (extensionSequence.length !== 1 || extensionSequence[0].tag !== 0x30) refuse();

  let deploymentEnvironment;
  for (const extension of derChildren(bytes, extensionSequence[0])) {
    if (extension.tag !== 0x30) refuse();
    const fields = derChildren(bytes, extension);
    if (fields.length < 2 || fields.length > 3 || fields[0].tag !== 0x06) refuse();
    let valueIndex = 1;
    if (fields[valueIndex]?.tag === 0x01) {
      const critical = fields[valueIndex];
      if (critical.contentEnd - critical.contentStart !== 1 ||
          ![0x00, 0xff].includes(bytes[critical.contentStart])) refuse();
      valueIndex += 1;
    }
    if (fields.length !== valueIndex + 1 || fields[valueIndex].tag !== 0x04) refuse();
    if (derOid(bytes, fields[0]) !== DEPLOYMENT_ENVIRONMENT_OID) continue;
    if (deploymentEnvironment !== undefined) refuse();
    const encodedValue = readDerNode(bytes, fields[valueIndex].contentStart, fields[valueIndex].contentEnd);
    if (encodedValue.tag !== 0x0c || encodedValue.next !== fields[valueIndex].contentEnd) refuse();
    try {
      deploymentEnvironment = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(bytes.subarray(encodedValue.contentStart, encodedValue.contentEnd));
    } catch {
      refuse();
    }
  }
  return deploymentEnvironment;
}

export function verifyDeploymentEnvironment(attestation, certificate) {
  const environment = deploymentEnvironmentFromCertificate(certificateRawBytes(attestation));
  if (environment !== ATTESTATION_ENVIRONMENT) refuse();
  for (const field of ['deploymentEnvironment', 'DeploymentEnvironment']) {
    if (Object.hasOwn(certificate, field) && certificate[field] !== environment) refuse();
  }
}
