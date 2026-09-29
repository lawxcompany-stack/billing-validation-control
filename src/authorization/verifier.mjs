import { openSync, readSync, closeSync } from 'node:fs';
import { AuthorizationRefusal } from './manifest.mjs';
import { readAuthorizationContext } from './context.mjs';
import { createSystemProcessBoundary, ISOLATED_DOCKER_CONTEXT } from '../../runner/process-boundary.mjs';
import { snapshotVerificationInput, verifyLocalAuthorizationWithDependencies } from './verifier-internal.mjs';

// Local station administration provisions reviewed SHAs after the remote commit
// is final. Neither GitHub main, ENV nor a caller/manifest can supply these pins.
function readPolicy(relativePath, code) {
  let fd;
  try {
    fd = openSync(new URL(relativePath, import.meta.url), 'r');
    const bytes = Buffer.alloc(65_537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > 65_536) throw new Error('policy_too_large');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch { throw new AuthorizationRefusal(code); }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { throw new AuthorizationRefusal(code); }
    }
  }
}

export async function verifyLocalAuthorization(input) {
  if (arguments.length !== 1) throw new AuthorizationRefusal('authorization_input_invalid');
  const snapshot = snapshotVerificationInput(input);
  const trustPolicy = readPolicy('../../policy/local-collector-trust.json', 'authorization_trust_invalid');
  const releasePolicy = readPolicy('../../policy/local-collector-release.json', 'authorization_release_invalid');
  return verifyLocalAuthorizationWithDependencies({ ...snapshot, trustPolicy, releasePolicy,
    readContext: readAuthorizationContext,
    boundary: createSystemProcessBoundary({ dockerContext: ISOLATED_DOCKER_CONTEXT }),
  });
}
