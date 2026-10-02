import { createRequire } from 'node:module';
import { constants as fsConstants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePreviewDeployment } from '../src/github/deployments.mjs';
import { createVercelReadClient } from '../src/github/vercel-read-client.mjs';
import {
  BILLING_RESULT_MANIFEST_LIMITS,
  createBillingResultManifest,
  createBillingResultTrustedContext,
  serializeBillingResultManifest,
  validateBillingResultInput,
} from './billing-result-manifest.mjs';

const require = createRequire(import.meta.url);
const POLICY = require('../policy/environment-policy.json');
const INPUT_BASENAME = 'billing-45-result-input.json';
const OUTPUT_BASENAME = 'billing-result-manifest.json';

function refuse() {
  const error = new Error('billing_result_manifest_write_refused');
  error.code = 'billing_result_manifest_write_refused';
  throw error;
}

function trustedPath(value, basename) {
  return typeof value === 'string' && path.isAbsolute(value) && path.basename(value) === basename;
}

async function readResultInput(filePath) {
  let handle;
  let bytes;
  try {
    if (!Number.isInteger(fsConstants.O_NOFOLLOW)) refuse();
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > BILLING_RESULT_MANIFEST_LIMITS.inputBytes) refuse();
    bytes = await handle.readFile();
    if (bytes.byteLength === 0 || bytes.byteLength > BILLING_RESULT_MANIFEST_LIMITS.inputBytes) refuse();
  } catch { refuse(); }
  finally {
    if (handle) {
      try { await handle.close(); }
      catch { refuse(); }
    }
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { refuse(); }
  try { return JSON.parse(text); }
  catch { refuse(); }
}

export async function createTrustedWorkflowBillingResultManifest({ environment, input, policy = POLICY,
  fetchImpl = globalThis.fetch } = {}) {
  const trustedContext = createBillingResultTrustedContext(environment, policy);
  const validatedInput = validateBillingResultInput(input);
  const api = createVercelReadClient({
    token: environment.VERCEL_READ_ONLY_TOKEN,
    candidateSha: trustedContext.candidate.sha,
    projectId: policy.vercel.projectId,
    teamId: policy.vercel.teamId,
    fetchImpl,
  });
  const deployment = await resolvePreviewDeployment({
    api,
    candidate: {
      candidateSha: trustedContext.candidate.sha,
      treeSha: trustedContext.candidateTreeSha,
    },
    policy,
  });
  return createBillingResultManifest(validatedInput, trustedContext, deployment);
}

export async function writeWorkflowBillingResultManifest(environment = process.env) {
  const inputPath = environment?.BILLING_RESULT_INPUT_PATH;
  const outputPath = environment?.BILLING_RESULT_MANIFEST_PATH;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) ||
      !trustedPath(inputPath, INPUT_BASENAME) || !trustedPath(outputPath, OUTPUT_BASENAME)) refuse();

  const input = await readResultInput(inputPath);
  // Only the resolver's API result can supply deployment identity. The result
  // artifact is closed to case results and is never treated as deployment proof.
  const manifest = await createTrustedWorkflowBillingResultManifest({ environment, input });
  const canonicalBytes = serializeBillingResultManifest(manifest);
  try {
    await writeFile(outputPath, canonicalBytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch {
    refuse();
  }
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const manifest = await writeWorkflowBillingResultManifest();
    console.log(`Billing result manifest ready for ${manifest.results.passedCount}/${manifest.results.totalCount} canonical cases.`);
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z_]+$/u.test(error.code)
      ? error.code : 'billing_result_manifest_write_refused';
    console.error(`billing_result_manifest_write_refused:${code}`);
    process.exitCode = 1;
  }
}
