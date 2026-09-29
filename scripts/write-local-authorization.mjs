import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotLocalAuthorizationEnvironment, localAuthorizationContextFromEnvironment,
  parseLocalAuthorizationDispatch, parseLocalAuthorizationJson } from '../src/authorization/dispatch.mjs';
import { emitLocalAuthorization, validateLocalAuthorizationReceipt } from '../src/authorization/emitter.mjs';
import { authorizationDigest, serializeAuthorizationManifest } from '../src/authorization/manifest.mjs';

export async function main(env = process.env) {
  try {
    const e = snapshotLocalAuthorizationEnvironment(env, ['CANDIDATE_RECEIPT', 'RUNNER_TEMP']);
    const context = localAuthorizationContextFromEnvironment(e);
    const dispatch = parseLocalAuthorizationDispatch(parseLocalAuthorizationJson(e.DISPATCH_INPUTS), context);
    const receipt = validateLocalAuthorizationReceipt(parseLocalAuthorizationJson(e.CANDIDATE_RECEIPT), dispatch.candidate_sha);
    if (!path.isAbsolute(e.RUNNER_TEMP)) throw new Error();
    const releasePolicy = JSON.parse(await readFile(new URL('../policy/local-collector-release.json', import.meta.url), 'utf8'));
    const manifest = emitLocalAuthorization({ dispatch, receipt, context, releasePolicy, now: new Date() });
    const bytes = serializeAuthorizationManifest(manifest);
    const digest = authorizationDigest(bytes);
    await writeFile(path.join(e.RUNNER_TEMP, 'local-collector-authorization.json'), bytes, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ scope: 'authorization-only', authorizationDigest: digest }));
    return 0;
  } catch {
    console.error('local_authorization_refused (authorization_writer_failed)');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('local_authorization_refused (authorization_arguments_invalid)'); process.exitCode = 1;
  } else process.exitCode = await main();
}
