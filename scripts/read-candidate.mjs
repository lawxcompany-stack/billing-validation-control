import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DispatchRefusal } from '../src/contracts/dispatch.mjs';
import { CandidateRefusal } from '../src/github/candidate.mjs';
import { CandidateChecksRefusal } from '../src/github/candidate-checks.mjs';
import { readCandidatePrerequisites } from '../src/github/candidate-reader.mjs';
import { CandidateReadRefusal, createCandidateReadClient } from '../src/github/read-client.mjs';

export async function main(env = process.env) {
  try {
    const context = { repository: env.CONTROL_REPOSITORY, repositoryId: env.CONTROL_REPOSITORY_ID,
      ref: env.CONTROL_REF,
      defaultBranch: env.CONTROL_DEFAULT_BRANCH, refProtected: env.CONTROL_REF_PROTECTED === 'true',
      eventName: env.CONTROL_EVENT_NAME };
    const api = createCandidateReadClient({ token: env.CANDIDATE_READ_TOKEN });
    const receipt = await readCandidatePrerequisites({ api, candidateSha: env.CANDIDATE_SHA, context });
    if (env.GITHUB_OUTPUT) {
      await appendFile(env.GITHUB_OUTPUT, [
        `candidate_sha=${receipt.candidateSha}`, `candidate_tree_sha=${receipt.treeSha}`,
        `candidate_base_sha=${receipt.baseSha}`, `candidate_pull_number=${receipt.pullNumber}`,
        `ci_run_id=${receipt.runId}`, `ci_run_attempt=${receipt.attempt}`, '',
      ].join('\n'));
    }
    console.log(JSON.stringify({ scope: receipt.scope, candidateSha: receipt.candidateSha,
      runId: receipt.runId, attempt: receipt.attempt, checks: receipt.jobs.map(job => job.key) }));
    return 0;
  } catch (error) {
    const known = [DispatchRefusal, CandidateRefusal, CandidateChecksRefusal, CandidateReadRefusal]
      .some((ErrorType) => error instanceof ErrorType);
    const code = known ? error.code : 'candidate_reader_failed';
    console.error(`candidate_reader_refused (${code})`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
