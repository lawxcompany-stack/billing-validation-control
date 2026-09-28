import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createActivationManifest, serializeActivationManifest } from './activation-manifest.mjs';

const CONTROL_REPOSITORY = 'lawxcompany-stack/billing-validation-control';
const CONTROL_REF = 'refs/heads/main';
const CONTROL_WORKFLOW_PATH = '.github/workflows/validate-billing.yml';

export async function writeWorkflowActivationManifest(environment = process.env) {
  const expectedWorkflowRef = `${CONTROL_REPOSITORY}/${CONTROL_WORKFLOW_PATH}@${CONTROL_REF}`;
  const filePath = environment?.ACTIVATION_MANIFEST_PATH;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) ||
      typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.basename(filePath) !== 'activation-manifest.json' ||
      environment.CONTROL_WORKFLOW_REF !== expectedWorkflowRef) {
    const error = new Error('activation_manifest_invalid');
    error.code = 'activation_manifest_invalid';
    throw error;
  }

  const manifest = createActivationManifest({
    activationCommitment: environment.ACTIVATION_COMMITMENT,
    candidateRepository: 'lawxcompany-stack/Plataforma-LawX',
    candidateSha: environment.CANDIDATE_SHA,
    runnerLabel: environment.RUNNER_LABEL,
    controlRepository: environment.CONTROL_REPOSITORY,
    controlRepositoryId: environment.CONTROL_REPOSITORY_ID,
    controlRef: environment.CONTROL_REF,
    controlWorkflowPath: CONTROL_WORKFLOW_PATH,
    runId: environment.CONTROL_RUN_ID,
    runAttempt: environment.CONTROL_RUN_ATTEMPT,
    controlWorkflowSha: environment.CONTROL_WORKFLOW_SHA,
    eventName: environment.CONTROL_EVENT_NAME,
  });
  const canonicalBytes = serializeActivationManifest(manifest);
  await writeFile(filePath, canonicalBytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    await writeWorkflowActivationManifest();
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z_]+$/u.test(error.code)
      ? error.code : 'activation_manifest_invalid';
    console.error(`activation_manifest_write_refused:${code}`);
    process.exitCode = 1;
  }
}
