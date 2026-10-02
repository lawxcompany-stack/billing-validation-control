import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BILLING_RESULT_MANIFEST_LIMITS, validateBillingResultInput } from './billing-result-manifest.mjs';

const INPUT_BASENAME = 'billing-45-result-input.json';

function refuse() {
  const error = new Error('billing_result_input_invalid');
  error.code = 'billing_result_input_invalid';
  throw error;
}

export async function validateWorkflowBillingResultInput(environment = process.env) {
  const filePath = environment?.BILLING_RESULT_INPUT_PATH;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) ||
      typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.basename(filePath) !== INPUT_BASENAME ||
      !Number.isInteger(fsConstants.O_NOFOLLOW)) refuse();

  let handle;
  let bytes;
  try {
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

  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { refuse(); }
  return validateBillingResultInput(input);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const input = await validateWorkflowBillingResultInput();
    console.log(`Validated ${input.results.length} canonical billing result records.`);
  } catch {
    console.error('billing_result_input_invalid');
    process.exitCode = 1;
  }
}
