import { types } from 'node:util';
import { AuthorizationRefusal } from './manifest.mjs';

function invalid() { throw new Error('invalid_policy'); }

function record(input, schema) {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== Object.keys(schema).length || keys.some((key) => !Object.hasOwn(schema, key))) invalid();
  const output = {};
  for (const [key, validate] of Object.entries(schema)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    output[key] = validate(descriptor.value);
  }
  return Object.freeze(output);
}

function list(input, validate, max = 128) {
  if (!input || types.isProxy(input) || !Array.isArray(input)
    || Object.getPrototypeOf(input) !== Array.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const length = descriptors.length.value;
  if (length > max || Reflect.ownKeys(descriptors).length !== length + 1) invalid();
  const output = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    output.push(validate(descriptor.value));
  }
  return Object.freeze(output);
}

const version = (value) => { if (value !== 1) invalid(); return value; };
const matches = (pattern) => (value) => {
  if (typeof value !== 'string' || !pattern.test(value)) invalid();
  return value;
};
const sha = matches(/^[a-f0-9]{40}$/u);
const digest = matches(/^[a-f0-9]{64}$/u);
const suite = (value) => { if (!['billing-43', 'billing-3ds-15'].includes(value)) invalid(); return value; };

export function validateReleasePolicy(value) {
  try {
    return record(value, { schemaVersion: version, releases: (releases) => list(releases, (release) => record(release, {
      collectorRelease: (pin) => record(pin, {
        image: matches(/^ghcr\.io\/lawxcompany-stack\/billing-validation-control@sha256:[a-f0-9]{64}$/u),
        configDigest: matches(/^sha256:[a-f0-9]{64}$/u), sourceSha: sha, sourceTreeSha: sha, policyDigest: digest,
      }),
      policy: (pin) => record(pin, { environmentDigest: digest, contractsDigest: digest, egressDigest: digest, limitsDigest: digest }),
      suites: (values) => {
        const suites = list(values, suite, 2);
        if (suites.length === 0 || new Set(suites).size !== suites.length) invalid();
        return suites;
      },
    })) });
  } catch { throw new AuthorizationRefusal('authorization_release_invalid'); }
}

export function selectRelease(value, selectedSuite) {
  const policy = validateReleasePolicy(value);
  try { suite(selectedSuite); } catch { throw new AuthorizationRefusal('authorization_release_invalid'); }
  const matches = policy.releases.filter((release) => release.suites.includes(selectedSuite));
  if (matches.length === 0) throw new AuthorizationRefusal('authorization_release_unconfigured');
  if (matches.length !== 1) throw new AuthorizationRefusal('authorization_release_ambiguous');
  return matches[0];
}

export function validateTrustPolicy(value) {
  try {
    return record(value, { schemaVersion: version, reviewedControlShas: (values) => {
      const shas = list(values, sha);
      if (new Set(shas).size !== shas.length) invalid();
      return shas;
    } });
  } catch { throw new AuthorizationRefusal('authorization_trust_invalid'); }
}
