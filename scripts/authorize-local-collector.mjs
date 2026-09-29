import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AuthorizationRefusal } from '../src/authorization/manifest.mjs';
import { parseLocalAuthorizationDispatch, snapshotLocalAuthorizationEnvironment,
  localAuthorizationContextFromEnvironment, parseLocalAuthorizationJson } from '../src/authorization/dispatch.mjs';
import { selectRelease } from '../src/authorization/release-policy.mjs';

export async function main(env = process.env) {
  try {
    const e = snapshotLocalAuthorizationEnvironment(env, ['GITHUB_OUTPUT']);
    const context = localAuthorizationContextFromEnvironment(e);
    const dispatch = parseLocalAuthorizationDispatch(parseLocalAuthorizationJson(e.DISPATCH_INPUTS), context);
    // Trusted checkout policy only. Admission is not emitted until a unique release exists.
    const policy = JSON.parse(await readFile(new URL('../policy/local-collector-release.json', import.meta.url), 'utf8'));
    selectRelease(policy, dispatch.suite);
    await appendFile(e.GITHUB_OUTPUT, `dispatch=${JSON.stringify(dispatch)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof AuthorizationRefusal && [
      'authorization_release_unconfigured', 'authorization_release_invalid', 'authorization_release_ambiguous',
    ].includes(error.code) ? error.code : 'authorization_admission_failed';
    console.error(`local_authorization_refused (${code})`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('local_authorization_refused (authorization_arguments_invalid)'); process.exitCode = 1;
  } else process.exitCode = await main();
}
