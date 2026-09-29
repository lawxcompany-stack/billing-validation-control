import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseLocalAuthorizationDispatch, snapshotLocalAuthorizationEnvironment,
  localAuthorizationContextFromEnvironment, parseLocalAuthorizationJson } from '../src/authorization/dispatch.mjs';
import { validateLocalAuthorizationReceipt } from '../src/authorization/emitter.mjs';
import { readCandidatePrerequisites } from '../src/github/candidate-reader.mjs';
import { createCandidateReadClient } from '../src/github/read-client.mjs';

export async function main(env = process.env) {
  try {
    const e = snapshotLocalAuthorizationEnvironment(env, ['CANDIDATE_READ_TOKEN', 'GITHUB_OUTPUT']);
    const context = localAuthorizationContextFromEnvironment(e);
    const dispatch = parseLocalAuthorizationDispatch(parseLocalAuthorizationJson(e.DISPATCH_INPUTS), context);
    const api = createCandidateReadClient({ token: e.CANDIDATE_READ_TOKEN });
    const receipt = validateLocalAuthorizationReceipt(await readCandidatePrerequisites({ api,
      candidateSha: dispatch.candidate_sha, context }), dispatch.candidate_sha);
    const json = JSON.stringify(receipt);
    if (Buffer.byteLength(json) > 16_384) throw new Error();
    await appendFile(e.GITHUB_OUTPUT, `receipt=${json}\n`);
    return 0;
  } catch {
    console.error('local_authorization_refused (authorization_reader_failed)');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('local_authorization_refused (authorization_arguments_invalid)'); process.exitCode = 1;
  } else process.exitCode = await main();
}
