import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CANDIDATE_REPOSITORY = 'lawxcompany-stack/Plataforma-LawX';
const DEFAULT_BASE_BRANCH = 'preview';
const FULL_SHA = /^[0-9a-f]{40}$/iu;
const MAX_CHANGED_FILES = 300;
const DEFAULT_SOURCE_PINS = require('../../policy/source-pins.json');

export class CandidateRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'CandidateRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new CandidateRefusal(code);
}

async function getJson(api, path) {
  try {
    return await api.get(path);
  } catch {
    refuse('candidate_api_unavailable');
  }
}

function validatePins(sourcePins) {
  if (sourcePins === null || typeof sourcePins !== 'object' || Array.isArray(sourcePins) ||
      sourcePins.schema_version !== 1 || !Array.isArray(sourcePins.protected_prefixes) ||
      !Array.isArray(sourcePins.protected_paths) || sourcePins.reviewed_blobs === null ||
      typeof sourcePins.reviewed_blobs !== 'object' || Array.isArray(sourcePins.reviewed_blobs)) {
    refuse('source_pin_policy_invalid');
  }
  const validPath = (path) => typeof path === 'string' && path.length > 0 &&
    !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((part) => part === '.' || part === '..');
  if (!sourcePins.protected_prefixes.every(validPath) || !sourcePins.protected_paths.every(validPath)) {
    refuse('source_pin_policy_invalid');
  }
  for (const [path, hashes] of Object.entries(sourcePins.reviewed_blobs)) {
    if (!validPath(path) || !Array.isArray(hashes) || hashes.length === 0 ||
        !hashes.every((hash) => typeof hash === 'string' && FULL_SHA.test(hash))) {
      refuse('source_pin_policy_invalid');
    }
  }
}

function isProtected(path, pins) {
  return pins.protected_paths.includes(path) || pins.protected_prefixes.some((prefix) => path.startsWith(prefix));
}

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
    !path.includes('\\') && !path.split('/').some((part) => part === '.' || part === '..');
}

async function readChangedFiles(api, pullNumber) {
  const files = [];
  for (let page = 1; page <= 3; page += 1) {
    const response = await getJson(api,
      `/repos/${CANDIDATE_REPOSITORY}/pulls/${pullNumber}/files?per_page=100&page=${page}`);
    if (!Array.isArray(response)) refuse('candidate_file_list_invalid');
    files.push(...response);
    if (response.length < 100) return files;
  }
  if (files.length >= MAX_CHANGED_FILES) refuse('candidate_change_set_too_large');
  return files;
}

export async function resolveCandidate({ api, candidateSha, sourcePins = DEFAULT_SOURCE_PINS, baseBranch = DEFAULT_BASE_BRANCH }) {
  if (!api || typeof api.get !== 'function' || !FULL_SHA.test(candidateSha ?? '') ||
      baseBranch !== DEFAULT_BASE_BRANCH) refuse('candidate_input_invalid');
  validatePins(sourcePins);
  const normalizedSha = candidateSha.toLowerCase();
  const pulls = await getJson(api,
    `/repos/${CANDIDATE_REPOSITORY}/commits/${normalizedSha}/pulls?per_page=100`);
  if (!Array.isArray(pulls) || pulls.length === 0) refuse('candidate_pr_not_found');

  const associated = pulls.filter((pull) => pull && typeof pull === 'object');
  if (associated.some((pull) => pull.head?.repo?.full_name !== CANDIDATE_REPOSITORY ||
      pull.base?.repo?.full_name !== CANDIDATE_REPOSITORY)) {
    refuse('candidate_repository_not_allowed');
  }
  const openPreviewPulls = associated.filter((pull) => pull.state === 'open' && pull.base?.ref === baseBranch);
  if (openPreviewPulls.some((pull) => pull.head?.sha !== normalizedSha)) refuse('candidate_head_not_current');
  const matches = openPreviewPulls.filter((pull) => pull.head?.sha === normalizedSha);
  if (matches.length === 0) {
    if (associated.some((pull) => pull.state === 'open' && pull.base?.ref !== baseBranch)) refuse('candidate_base_not_allowed');
    refuse('candidate_pr_not_found');
  }
  if (matches.length !== 1) refuse('candidate_pr_ambiguous');

  const pull = matches[0];
  if (!Number.isSafeInteger(pull.number) || pull.number < 1 || !FULL_SHA.test(pull.base?.sha ?? '') ||
      !Number.isSafeInteger(pull.head?.repo?.id) || pull.head.repo.id !== pull.base?.repo?.id) {
    refuse('candidate_pr_metadata_invalid');
  }

  const fileRecords = await readChangedFiles(api, pull.number);
  const changedFiles = [];
  const fileStatusByPath = new Map();
  for (const file of fileRecords) {
    if (!safePath(file?.filename) || !['added', 'modified', 'removed', 'renamed', 'copied', 'changed'].includes(file.status)) {
      refuse('candidate_file_list_invalid');
    }
    if (changedFiles.includes(file.filename)) refuse('candidate_file_list_invalid');
    changedFiles.push(file.filename);
    fileStatusByPath.set(file.filename, file.status);
  }
  const commit = await getJson(api, `/repos/${CANDIDATE_REPOSITORY}/git/commits/${normalizedSha}`);
  if (!commit || commit.sha?.toLowerCase() !== normalizedSha || !FULL_SHA.test(commit.tree?.sha ?? '')) {
    refuse('candidate_tree_inconsistent');
  }
  const candidateTreeSha = commit.tree.sha.toLowerCase();
  const tree = await getJson(api, `/repos/${CANDIDATE_REPOSITORY}/git/trees/${candidateTreeSha}?recursive=1`);
  if (!tree || tree.truncated !== false || !Array.isArray(tree.tree) || !FULL_SHA.test(tree.sha ?? '') ||
      tree.sha.toLowerCase() !== candidateTreeSha) refuse('candidate_tree_inconsistent');
  const blobs = new Map();
  for (const entry of tree.tree) {
    if (entry?.type === 'blob' && typeof entry.path === 'string' && FULL_SHA.test(entry.sha ?? '')) {
      blobs.set(entry.path, entry.sha.toLowerCase());
    }
  }

  const sourceBlobShas = {};
  for (const path of changedFiles) {
    const blobSha = blobs.get(path);
    const removed = fileStatusByPath.get(path) === 'removed';
    if ((removed && blobSha) || (!removed && !blobSha)) refuse('candidate_tree_inconsistent');
    if (!blobSha) {
      if (isProtected(path, sourcePins)) refuse('candidate_protected_source_unreviewed');
      continue;
    }
    sourceBlobShas[path] = blobSha;
    if (isProtected(path, sourcePins) && !sourcePins.reviewed_blobs[path]?.includes(blobSha)) {
      refuse('candidate_protected_source_unreviewed');
    }
  }

  return Object.freeze({
    repository: CANDIDATE_REPOSITORY,
    repositoryId: pull.head.repo.id,
    pullNumber: pull.number,
    candidateSha: normalizedSha,
    baseSha: pull.base.sha.toLowerCase(),
    treeSha: candidateTreeSha,
    sourceBlobShas: Object.freeze(sourceBlobShas),
    changedFiles: Object.freeze(changedFiles.sort()),
  });
}
