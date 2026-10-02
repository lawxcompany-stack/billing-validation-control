import { types } from 'node:util';
import { AuthorizationRefusal } from './manifest.mjs';
import { CONTROL_REPOSITORY, CONTROL_REPOSITORY_ID } from '../contracts/control-identity.mjs';

const WORKFLOW = '.github/workflows/authorize-local-collector.yml';
const INPUTS = ['candidate_sha', 'execution_id', 'activation_commitment', 'suite'];
const CONTEXT = ['repository', 'repositoryId', 'ref', 'defaultBranch', 'refProtected', 'eventName',
  'workflowRef', 'workflowSha', 'sha', 'runId', 'runAttempt'];

function invalid() { throw new AuthorizationRefusal('authorization_dispatch_invalid'); }

// Shared descriptor-only snapshots: never call accessors, proxy traps or toJSON.
export function snapshotRecord(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) invalid();
  const copy = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !Object.hasOwn(d, 'value')) invalid();
    copy[key] = d.value;
  }
  return Object.freeze(copy);
}

export function validateLocalAuthorizationContext(value) {
  const c = snapshotRecord(value, CONTEXT);
  if (c.repository !== CONTROL_REPOSITORY || c.repositoryId !== CONTROL_REPOSITORY_ID || c.ref !== 'refs/heads/main'
    || c.defaultBranch !== 'main' || c.refProtected !== true || c.eventName !== 'workflow_dispatch'
    || c.workflowRef !== `${CONTROL_REPOSITORY}/${WORKFLOW}@refs/heads/main`
    || typeof c.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(c.sha) || c.workflowSha !== c.sha
    || ![c.runId, c.runAttempt].every(id => typeof id === 'string' && /^[1-9][0-9]*$/u.test(id)
      && Number.isSafeInteger(Number(id)) && String(Number(id)) === id)) invalid();
  return c;
}

export function parseLocalAuthorizationDispatch(inputs, context) {
  validateLocalAuthorizationContext(context);
  const d = snapshotRecord(inputs, INPUTS);
  for (const [key, length] of [['candidate_sha', 40], ['execution_id', 32], ['activation_commitment', 64]]) {
    if (typeof d[key] !== 'string' || d[key].length !== length || !/^[a-f0-9]+$/u.test(d[key])) invalid();
  }
  if (!['billing-43', 'billing-3ds-15'].includes(d.suite)) invalid();
  return d;
}

const CONTEXT_ENV = {
  repository: 'CONTROL_REPOSITORY', repositoryId: 'CONTROL_REPOSITORY_ID', ref: 'CONTROL_REF',
  defaultBranch: 'CONTROL_DEFAULT_BRANCH', refProtected: 'CONTROL_REF_PROTECTED', eventName: 'CONTROL_EVENT_NAME',
  workflowRef: 'CONTROL_WORKFLOW_REF', workflowSha: 'CONTROL_WORKFLOW_SHA', sha: 'CONTROL_SHA',
  runId: 'CONTROL_RUN_ID', runAttempt: 'CONTROL_RUN_ATTEMPT',
};

export function snapshotLocalAuthorizationEnvironment(env, fields) {
  if (!env || typeof env !== 'object' || types.isProxy(env)) invalid();
  const copy = {};
  for (const key of [...Object.values(CONTEXT_ENV), 'DISPATCH_INPUTS', ...fields]) {
    const d = Object.getOwnPropertyDescriptor(env, key);
    if (!d || !Object.hasOwn(d, 'value') || typeof d.value !== 'string' || d.value.length === 0) invalid();
    copy[key] = d.value;
  }
  return Object.freeze(copy);
}

export function localAuthorizationContextFromEnvironment(env) {
  const snapshot = snapshotLocalAuthorizationEnvironment(env, []);
  const context = {};
  for (const [key, field] of Object.entries(CONTEXT_ENV)) context[key] = snapshot[field];
  context.refProtected = context.refProtected === 'true';
  return validateLocalAuthorizationContext(context);
}

export function parseLocalAuthorizationJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16_384) invalid();
  try { return JSON.parse(text); } catch { invalid(); }
}
