import { createRequire } from 'node:module';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSystemProcessBoundary, ISOLATED_DOCKER_CONTEXT } from './process-boundary.mjs';
import { getReviewedControlRepositoryId } from './trust-policy.mjs';
import {
  BILLING_RESULT_MANIFEST_LIMITS,
  createBillingResultTrustedContext,
} from './billing-result-manifest.mjs';
import { verifyBillingResultAttestationWithBoundary } from './billing-result-verifier-internal.mjs';

const require = createRequire(import.meta.url);
const POLICY = require('../policy/environment-policy.json');
const PROCESS_BOUNDARY = createSystemProcessBoundary({ dockerContext: ISOLATED_DOCKER_CONTEXT });
const MANIFEST_BASENAME = 'billing-result-manifest.json';

export class BillingResultVerifierRefusal extends Error {
  constructor() {
    super('billing_result_attestation_invalid');
    this.name = 'BillingResultVerifierRefusal';
    this.code = 'billing_result_attestation_invalid';
  }
}

export async function verifyWorkflowBillingResultManifest(environment = process.env) {
  try {
    const manifestPath = environment?.BILLING_RESULT_MANIFEST_PATH;
    if (!environment || typeof environment !== 'object' || Array.isArray(environment) ||
        typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath) ||
        path.basename(manifestPath) !== MANIFEST_BASENAME) throw new Error('refused');
    if (!Number.isInteger(fsConstants.O_NOFOLLOW)) throw new Error('refused');
    const handle = await open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let manifestBytes;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size === 0 || metadata.size > BILLING_RESULT_MANIFEST_LIMITS.manifestBytes) {
        throw new Error('refused');
      }
      manifestBytes = await handle.readFile();
      if (manifestBytes.byteLength === 0 || manifestBytes.byteLength > BILLING_RESULT_MANIFEST_LIMITS.manifestBytes) {
        throw new Error('refused');
      }
    } finally {
      await handle.close();
    }
    const expectedContext = createBillingResultTrustedContext(environment, POLICY);
    return await verifyBillingResultAttestationWithBoundary({
      manifestBytes,
      expectedContext,
      processBoundary: PROCESS_BOUNDARY,
      reviewedControlRepositoryId: getReviewedControlRepositoryId(),
    });
  } catch {
    throw new BillingResultVerifierRefusal();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await verifyWorkflowBillingResultManifest();
    console.log(`Verified billing result attestation for ${result.manifest.results.passedCount}/${result.manifest.results.totalCount} canonical cases.`);
  } catch {
    console.error('billing_result_attestation_invalid');
    process.exitCode = 1;
  }
}
