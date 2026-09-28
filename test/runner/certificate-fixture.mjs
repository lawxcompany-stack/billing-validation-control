function derLength(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('invalid_der_length');
  if (length < 128) return Buffer.from([length]);
  const octets = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    octets.unshift(remaining & 0xff);
  }
  return Buffer.from([0x80 | octets.length, ...octets]);
}

function der(tag, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), derLength(bytes.length), bytes]);
}

function derSequence(...values) {
  return der(0x30, Buffer.concat(values));
}

function encodeBase128(value) {
  const octets = [value % 128];
  for (let remaining = Math.floor(value / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
    octets.unshift((remaining % 128) | 0x80);
  }
  return octets;
}

function derOid(value) {
  const arcs = value.split('.').map(Number);
  if (arcs.length < 2 || arcs.some((arc) => !Number.isSafeInteger(arc) || arc < 0) ||
      arcs[0] > 2 || (arcs[0] < 2 && arcs[1] > 39)) throw new TypeError('invalid_der_oid');
  const octets = [...encodeBase128(arcs[0] * 40 + arcs[1])];
  for (const arc of arcs.slice(2)) octets.push(...encodeBase128(arc));
  return der(0x06, Buffer.from(octets));
}

export function certificateFixture(environment = 'billing-validation-attestation') {
  const extensions = environment === null ? [] : [derSequence(
    derOid('1.3.6.1.4.1.57264.1.23'),
    der(0x04, der(0x0c, Buffer.from(environment, 'utf8'))),
  )];
  const signatureAlgorithm = derSequence(derOid('1.2.840.10045.4.3.2'));
  const commonName = derSequence(der(0x31, derSequence(
    derOid('2.5.4.3'),
    der(0x0c, Buffer.from('Billing validation fixture', 'utf8')),
  )));
  const validity = derSequence(
    der(0x17, Buffer.from('260101000000Z')),
    der(0x17, Buffer.from('270101000000Z')),
  );
  const publicKey = Buffer.from(
    '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
    '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
    'hex',
  );
  const subjectPublicKeyInfo = derSequence(
    derSequence(derOid('1.2.840.10045.2.1'), derOid('1.2.840.10045.3.1.7')),
    der(0x03, Buffer.concat([Buffer.from([0]), publicKey])),
  );
  const tbsFields = [
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    signatureAlgorithm,
    commonName,
    validity,
    commonName,
    subjectPublicKeyInfo,
  ];
  if (environment !== null) tbsFields.push(der(0xa3, derSequence(...extensions)));
  const tbsCertificate = derSequence(...tbsFields);
  const signature = der(0x03, Buffer.concat([Buffer.from([0]), derSequence(
    der(0x02, Buffer.from([1])),
    der(0x02, Buffer.from([1])),
  )]));
  return derSequence(tbsCertificate, signatureAlgorithm, signature).toString('base64');
}
