const FULL_SHA = /^[0-9a-f]{40}$/u;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/u;
const PROJECT_ID = /^prj_[A-Za-z0-9]+$/u;
const TEAM_ID = /^team_[A-Za-z0-9]+$/u;
const MAX_DEPLOYMENTS = 20;

export class DeploymentRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'DeploymentRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new DeploymentRefusal(code);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function immutableVercelOrigin(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase() || value.includes('*')) return null;
  let url;
  try {
    url = new URL(value.startsWith('https://') ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' ||
      url.search || url.hash || url.origin !== `https://${url.hostname}` || url.hostname !== value.replace(/^https:\/\//u, '')) {
    return null;
  }
  const hostname = url.hostname;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/u.test(hostname) || hostname.includes('-git-')) return null;
  const labels = hostname.slice(0, -'.vercel.app'.length).split('-');
  if (labels.length < 3 || !labels.some((label, index) => index > 0 && index < labels.length - 1 && /^[a-z0-9]{9}$/u.test(label))) {
    return null;
  }
  return url.origin;
}

function validateSelection(input) {
  const { api, candidate, policy } = input;
  if (!api || typeof api.get !== 'function' || !isObject(candidate) ||
      typeof candidate.candidateSha !== 'string' || !FULL_SHA.test(candidate.candidateSha) ||
      typeof candidate.treeSha !== 'string' || !FULL_SHA.test(candidate.treeSha)) refuse('deployment_input_invalid');
  if (!isObject(policy) || !isObject(policy.vercel) || !PROJECT_ID.test(policy.vercel.projectId ?? '') ||
      !TEAM_ID.test(policy.vercel.teamId ?? '')) refuse('deployment_policy_invalid');
}

async function getJson(api, path) {
  try {
    return await api.get(path);
  } catch {
    refuse('vercel_api_unavailable');
  }
}

function deploymentStatus(record) {
  if (!Object.hasOwn(record, 'state') && !Object.hasOwn(record, 'readyState')) return false;
  return (record.state === undefined || record.state === 'READY') &&
    (record.readyState === undefined || record.readyState === 'READY') &&
    (record.state === 'READY' || record.readyState === 'READY');
}

function deploymentOrigin(value) {
  const origin = immutableVercelOrigin(value);
  if (!origin) refuse('deployment_origin_invalid');
  return origin;
}

export async function resolvePreviewDeployment(input = {}) {
  validateSelection(input);
  const { api, candidate, policy } = input;
  const query = new URLSearchParams({
    projectId: policy.vercel.projectId,
    teamId: policy.vercel.teamId,
    target: 'preview',
    sha: candidate.candidateSha,
    state: 'READY',
    limit: String(MAX_DEPLOYMENTS),
  });
  const response = await getJson(api, `/v7/deployments?${query}`);
  if (!isObject(response) || !Array.isArray(response.deployments)) refuse('deployment_list_invalid');
  if (response.deployments.length === 0) refuse('deployment_not_found');
  if (response.deployments.length > 1) refuse('deployment_ambiguous');

  const listed = response.deployments[0];
  if (!isObject(listed) || !DEPLOYMENT_ID.test(listed.uid ?? '') || typeof listed.projectId !== 'string' ||
      !Object.hasOwn(listed, 'target') || !deploymentStatus(listed)) {
    if (isObject(listed) && !deploymentStatus(listed)) refuse('deployment_not_ready');
    refuse('deployment_metadata_invalid');
  }
  if (listed.projectId !== policy.vercel.projectId) refuse('deployment_project_mismatch');
  if (listed.target !== null) refuse('deployment_environment_mismatch');
  const listedOrigin = deploymentOrigin(listed.url);

  const detailQuery = new URLSearchParams({ withGitRepoInfo: 'true', teamId: policy.vercel.teamId });
  const detailPath = `/v13/deployments/${encodeURIComponent(listed.uid)}?${detailQuery}`;
  const detail = await getJson(api, detailPath);
  if (!isObject(detail) || !DEPLOYMENT_ID.test(detail.id ?? '') || !Object.hasOwn(detail, 'target') ||
      typeof detail.projectId !== 'string' || typeof detail.readyState !== 'string' ||
      !isObject(detail.gitSource) || typeof detail.url !== 'string') refuse('deployment_metadata_invalid');
  if (detail.id !== listed.uid || detail.teamId !== policy.vercel.teamId && detail.ownerId !== policy.vercel.teamId) {
    refuse('deployment_identity_mismatch');
  }
  if (detail.projectId !== policy.vercel.projectId) refuse('deployment_project_mismatch');
  if (detail.target !== null) refuse('deployment_environment_mismatch');
  if (detail.readyState !== 'READY') refuse('deployment_not_ready');
  if (typeof detail.gitSource.sha !== 'string') refuse('deployment_sha_missing');
  if (detail.gitSource.sha !== candidate.candidateSha) refuse('deployment_sha_mismatch');
  const detailOrigin = deploymentOrigin(detail.url);
  if (detailOrigin !== listedOrigin) refuse('deployment_identity_mismatch');
  if (Array.isArray(detail.alias) && detail.alias.some((alias) => alias === detail.url || alias === listed.url)) {
    refuse('deployment_origin_invalid');
  }

  return Object.freeze({ id: detail.id, origin: detailOrigin });
}
