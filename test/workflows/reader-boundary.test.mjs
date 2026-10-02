import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';
import { assertWorkflowSecretBoundary } from './secret-boundary.mjs';

const path = '.github/workflows/validate-billing.yml';
const workflow = () => YAML.parse(readFileSync(path, 'utf8'));

test('protected reader permits only a revoked-after-job App token with read access to the candidate repository', () => {
  assert.doesNotThrow(() => assertWorkflowSecretBoundary(workflow(), path));
});

for (const [name, change] of [
  ['write permission', (job) => { job.steps.find((step) => step.id === 'reader_token').with['permission-actions'] = 'write'; }],
  ['another repository', (job) => { job.steps.find((step) => step.id === 'reader_token').with.repositories = 'another-repo'; }],
  ['token not revoked', (job) => { job.steps.find((step) => step.id === 'reader_token').with['skip-token-revoke'] = true; }],
  ['unprotected ref', (job) => { job.if = "${{ github.event_name == 'workflow_dispatch' && needs.authorize.result == 'success' }}"; }],
  ['guard bypass', (job) => { job.if = job.if.replace(' }}', ' || true }}'); }],
  ['forged protected context', (job) => { job.steps.at(-1).env.CONTROL_REF_PROTECTED = 'true'; }],
  ['extra credentialed step', (job) => { job.steps.push({ run: 'node unreviewed.mjs' }); }],
  ['replaced setup step', (job) => { job.steps[1] = { uses: job.steps[0].uses, with: { repository: 'attacker/repo' } }; }],
  ['skipped reader', (job) => { job.steps.at(-1).if = '${{ false }}'; }],
  ['tolerated reader failure', (job) => { job.steps.at(-1)['continue-on-error'] = true; }],
  ['tolerated job failure', (job) => { job['continue-on-error'] = true; }],
  ['bracket secret', (job) => { job.env = { TOKEN: "${{ secrets['FINANCIAL_TOKEN'] }}" }; }],
  ['candidate checkout', (job) => { job.steps[0].with.ref = '${{ needs.authorize.outputs.candidate_sha }}'; }],
  ['financial secret', (job) => { job.steps.at(-1).env.STRIPE_SECRET_KEY = '${{ secrets.STRIPE_SECRET_KEY }}'; }],
  ['credential job output', (job) => { job.outputs.credential = '${{ steps.reader_token.outputs.token }}'; }],
]) {
  test(`reader boundary rejects ${name}`, () => {
    const value = workflow();
    change(value.jobs.reader);
    assert.throws(() => assertWorkflowSecretBoundary(value, path));
  });
}

test('candidate policy job and financial placeholder still cannot receive secrets', () => {
  for (const key of ['policy', 'test', 'publisher']) {
    const value = workflow();
    value.jobs[key].env = { TOKEN: '${{ secrets.BILLING_READER_APP_PRIVATE_KEY }}' };
    assert.throws(() => assertWorkflowSecretBoundary(value, path));
  }
});

for (const [scope, reference, mutate] of [
  ['workflow', '${{ vars.DATABASE_URL }}', (value, env) => { value.env = env; }],
  ['job', '${{ vars.SUPABASE_VALIDATION_DATABASE_URL }}', (value, env) => { value.jobs.test.env = env; }],
  ['step', '${{ vars.DATABASE_URL }}', (value, env) => { value.jobs.test.steps[1].env = env; }],
  ['workflow', '${{ secrets.DATABASE_URL }}', (value, env) => { value.env = env; }],
  ['job', '${{ secrets.DATABASE_URL }}', (value, env) => { value.jobs.test.env = env; }],
  ['step', '${{ secrets.DATABASE_URL }}', (value, env) => { value.jobs.test.steps[1].env = env; }],
]) {
  const source = reference.includes('vars.') ? 'vars' : 'secrets';
  test(`workflow boundary rejects indirect ${source} database config reference in ${scope} env`, () => {
    const value = workflow();
    mutate(value, { APP_CONFIG: reference });
    assert.throws(() => assertWorkflowSecretBoundary(value, path));
  });
}

for (const [source, scope, reference, mutate] of [
  ['vars', 'workflow', "${{ vars['DATABASE_URL'] }}", (value, env) => { value.env = env; }],
  ['vars', 'job', "${{ vars['SUPABASE_VALIDATION_DATABASE_URL'] }}", (value, env) => { value.jobs.test.env = env; }],
  ['vars', 'step', "${{ vars['DATABASE_URL'] }}", (value, env) => { value.jobs.test.steps[1].env = env; }],
  ['secrets', 'workflow', "${{ secrets['DATABASE_URL'] }}", (value, env) => { value.env = env; }],
  ['secrets', 'job', "${{ secrets['DATABASE_URL'] }}", (value, env) => { value.jobs.test.env = env; }],
  ['secrets', 'step', "${{ secrets['DATABASE_URL'] }}", (value, env) => { value.jobs.test.steps[1].env = env; }],
]) {
  test(`workflow boundary rejects indirect bracket ${source} database config reference at ${scope} env`, () => {
    const value = workflow();
    mutate(value, { APP_CONFIG: reference });
    assert.throws(() => assertWorkflowSecretBoundary(value, path));
  });
}

test('workflow boundary rejects a computed vars selector in step env', () => {
  const value = workflow();
  value.jobs.test.steps[1].env = { APP_CONFIG: "${{ vars[format('DATABASE_URL')] }}" };
  assert.throws(() => assertWorkflowSecretBoundary(value, path));
});

test('workflow boundary does not confuse an outputs property named vars with a provider context', () => {
  const value = workflow();
  value.jobs.test.env = { APP_CONFIG: '${{ needs.authorize.outputs.vars }}' };
  assert.doesNotThrow(() => assertWorkflowSecretBoundary(value, path));
});

test('workflow boundary ignores expression-like examples in non-evaluated input descriptions', () => {
  const value = workflow();
  value.on.workflow_dispatch.inputs.candidate_sha.description = 'Example only: ${{ vars.DATABASE_URL }}';
  assert.doesNotThrow(() => assertWorkflowSecretBoundary(value, path));
});

for (const [name, mutate] of [
  ['a local credential file', (value) => { value.jobs.test.steps[1].run = 'node --env-file=.env.local runner/collect.mjs'; }],
  ['a workflow-level env provider credential name', (value) => {
    value.env = { SUPABASE_SERVICE_ROLE_KEY: 'synthetic-provider-key-sentinel' };
  }],
  ['a workflow-level env secret reference', (value) => {
    value.env = { SYNTHETIC_CREDENTIAL: '${{ secrets.SYNTHETIC_TEST_CREDENTIAL }}' };
  }],
  ['a Production variable ref', (value) => {
    value.jobs.test.env = { SUPABASE_PROJECT_REF: '${{ vars.PRODUCTION_SUPABASE_PROJECT_REF }}' };
  }],
  ['an opaque Supabase URL', (value) => {
    const ref = 'kvmmnwmfgkhipuxmuxbr';
    value.jobs.test.steps[1].run = `printf '%s' 'postgresql://synthetic:synthetic@db.${ref}.supabase.co:5432/postgres'`;
  }],
  ['an opaque JWT credential', (value) => {
    value.jobs.test.env = {
      CANDIDATE_CREDENTIAL: 'eyJhbGciOiJIUzI1NiJ9.eyJyZWYiOiJ3bGtva2ZkYWF0dmdnaXR0aWtjciIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.synthetic_signature_123456',
    };
  }],
  ['a Live Stripe key', (value) => { value.jobs.test.env = { STRIPE_SECRET_KEY: 'sk_live_synthetic12345678' }; }],
]) {
  test(`workflow credential boundary rejects ${name}`, () => {
    const value = workflow();
    mutate(value);
    assert.throws(() => assertWorkflowSecretBoundary(value, path));
  });
}

for (const [name, literal] of [
  ['Stripe sk_test secret key', 'sk_test_synthetic_secret_key_0123456789'],
  ['Stripe rk_test restricted key', 'rk_test_synthetic_restricted_key_0123456789'],
  ['Stripe sk_live secret key', 'sk_live_synthetic_secret_key_0123456789'],
  ['Stripe rk_live restricted key', 'rk_live_synthetic_restricted_key_0123456789'],
  ['PostgreSQL database URL', 'postgresql://synthetic:synthetic@db.attacker.invalid:5432/billing_validation'],
  ['MySQL database URL', 'mysql://synthetic:synthetic@db.attacker.invalid:3306/billing_validation'],
]) {
  test(`workflow credential boundary rejects an embedded ${name}`, () => {
    const value = workflow();
    value.jobs.test.steps[1].run = `printf '%s' '${literal}'`;
    assert.throws(() => assertWorkflowSecretBoundary(value, path));
  });
}

test('workflow credential boundary rejects driver-qualified database URLs at opaque hosts', () => {
  for (const databaseUrl of [
    'postgresql+psycopg://synthetic:synthetic@db.attacker.invalid:5432/billing_validation',
    'postgres+psycopg://synthetic:synthetic@db.attacker.invalid:5432/billing_validation',
    'mysql+pymysql://synthetic:synthetic@db.attacker.invalid:3306/billing_validation',
    'mariadb+asyncmy://synthetic:synthetic@db.attacker.invalid:3306/billing_validation',
    'mongodb+srv://synthetic:synthetic@cluster.attacker.invalid/billing_validation',
    'redis://synthetic:synthetic@cache.attacker.invalid:6379/0',
    'rediss://synthetic:synthetic@cache.attacker.invalid:6379/0',
    'sqlserver://synthetic:synthetic@db.attacker.invalid:1433/billing_validation',
    'mssql+pyodbc://synthetic:synthetic@db.attacker.invalid:1433/billing_validation',
  ]) {
    const value = workflow();
    value.jobs.test.steps[1].run = `printf '%s' '${databaseUrl}'`;
    assert.throws(() => assertWorkflowSecretBoundary(value, path), /must not import a database URL/u);
  }
});

test('workflow boundary ignores Production and Live words in harmless step labels', () => {
  const value = workflow();
  value.jobs.test.steps[1].name = 'Reject Production credentials and Live destinations';
  assert.doesNotThrow(() => assertWorkflowSecretBoundary(value, path));
});

test('workflow boundary ignores Production in harmless workflow run-name', () => {
  const value = workflow();
  value['run-name'] = 'Production billing-validation check';
  assert.doesNotThrow(() => assertWorkflowSecretBoundary(value, path));
});
