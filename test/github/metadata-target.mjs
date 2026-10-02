function eligibleRun(run, { repository, workflowId, workflowPath }) {
  return Number.isSafeInteger(run?.id) && run.id > 0 &&
    run.workflow_id === workflowId && run.path === workflowPath && run.event === 'pull_request' &&
    run.status === 'completed' && run.conclusion === 'success' &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
    typeof run.head_sha === 'string' && /^[0-9a-f]{40}$/iu.test(run.head_sha) &&
    typeof run.created_at === 'string' && Number.isFinite(Date.parse(run.created_at)) &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository;
}

export async function findLatestPreviewRun({ runs, repository, workflowId, workflowPath, listPulls }) {
  if (!Array.isArray(runs) || typeof listPulls !== 'function' ||
      typeof repository !== 'string' || !Number.isSafeInteger(workflowId) ||
      typeof workflowPath !== 'string') {
    throw Object.assign(new Error('metadata_run_input_invalid'), { code: 'metadata_run_input_invalid' });
  }

  const candidates = runs.filter((run) => eligibleRun(run, { repository, workflowId, workflowPath }))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id);

  for (const run of candidates) {
    const pulls = await listPulls(run.head_sha);
    if (!Array.isArray(pulls)) {
      throw Object.assign(new Error('metadata_pull_list_invalid'), { code: 'metadata_pull_list_invalid' });
    }
    const exactPreviewPulls = pulls.filter((pull) => pull?.head?.sha === run.head_sha &&
      pull.head?.repo?.full_name === repository && pull.base?.ref === 'preview' &&
      pull.base?.repo?.full_name === repository);
    if (exactPreviewPulls.length > 1) {
      throw Object.assign(new Error('metadata_preview_run_ambiguous'), { code: 'metadata_preview_run_ambiguous' });
    }
    if (exactPreviewPulls.length === 1) {
      return Object.freeze({ run, pull: exactPreviewPulls[0] });
    }
  }

  return null;
}
