import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

const workflowPaths = [
  '.github/workflows/validate-billing.yml',
  '.github/workflows/reconcile-billing-checks.yml',
  '.github/workflows/authorize-local-collector.yml',
];

function assertReaderBoundary(job) {
  assert.deepEqual(Object.keys(job).sort(), ['if', 'needs', 'runs-on', 'environment', 'timeout-minutes', 'permissions', 'outputs', 'steps'].sort());
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.deepEqual(job.outputs, {
    candidate_sha: '${{ steps.candidate.outputs.candidate_sha }}',
    candidate_tree_sha: '${{ steps.candidate.outputs.candidate_tree_sha }}',
    candidate_base_sha: '${{ steps.candidate.outputs.candidate_base_sha }}',
    candidate_pull_number: '${{ steps.candidate.outputs.candidate_pull_number }}',
    ci_run_id: '${{ steps.candidate.outputs.ci_run_id }}',
    ci_run_attempt: '${{ steps.candidate.outputs.ci_run_attempt }}',
  });
  assert.equal(job.environment, 'billing-validation-reader');
  assert.equal(job.needs, 'authorize');
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.env, undefined);
  assert.equal(job.if, "${{ github.event_name == 'workflow_dispatch' && github.repository == 'lawxcompany-stack/billing-validation-control' && github.repository_id == '1384018279' && github.ref == 'refs/heads/main' && github.event.repository.default_branch == 'main' && github.ref_protected && needs.authorize.result == 'success' && needs.authorize.outputs.environments_verified == 'true' }}");
  assert.equal(job.steps.length, 4, 'credentialed reader runs only the reviewed fixed steps');
  const [checkout, setup, token, consumer] = job.steps;
  for (const [step, allowed] of [
    [checkout, ['name', 'uses', 'with']], [setup, ['name', 'uses', 'with']],
    [token, ['name', 'id', 'uses', 'with']], [consumer, ['name', 'id', 'env', 'run']],
  ]) assert.deepEqual(Object.keys(step).sort(), allowed.sort());
  assert.equal(checkout.uses, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with.repository, undefined);
  assert.deepEqual(checkout.with, { ref: '${{ github.sha }}', 'persist-credentials': false });
  assert.equal(setup.uses, 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020');
  assert.deepEqual(setup.with, { 'node-version': '22', 'package-manager-cache': false });
  assert.equal(token.id, 'reader_token');
  assert.equal(token.uses, 'actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349');
  assert.deepEqual(token.with, {
    'app-id': '${{ vars.BILLING_READER_APP_ID }}',
    'private-key': '${{ secrets.BILLING_READER_APP_PRIVATE_KEY }}',
    owner: 'lawxcompany-stack', repositories: 'Plataforma-LawX',
    'permission-actions': 'read', 'permission-contents': 'read', 'permission-pull-requests': 'read',
    'skip-token-revoke': false,
  });
  assert.equal(consumer.id, 'candidate');
  assert.equal(consumer.run, 'node scripts/read-candidate.mjs');
  assert.deepEqual(consumer.env, {
    CONTROL_REPOSITORY: '${{ github.repository }}',
    CONTROL_REF: '${{ github.ref }}',
    CONTROL_DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}',
    CONTROL_REF_PROTECTED: '${{ github.ref_protected }}',
    CONTROL_EVENT_NAME: '${{ github.event_name }}',
    CANDIDATE_SHA: '${{ needs.authorize.outputs.candidate_sha }}',
    CANDIDATE_READ_TOKEN: '${{ steps.reader_token.outputs.token }}',
  });
  const serialized = JSON.stringify(job);
  assert.deepEqual(serialized.match(/\$\{\{[^}]*\bsecrets\b[^}]*\}\}/gu), ['${{ secrets.BILLING_READER_APP_PRIVATE_KEY }}']);
  assert.equal((serialized.match(/steps\.reader_token\.outputs\.token/gu) ?? []).length, 1,
    'the reader token may only be consumed by the fixed reader step');
}

function assertResultAttestationBoundary(job) {
  const expression = value => '${{ ' + value + ' }}';
  const guard = "!cancelled() && github.event_name == 'workflow_dispatch' && github.repository == 'lawxcompany-stack/billing-validation-control' && github.repository_id == '1384018279' && github.ref == 'refs/heads/main' && github.event.repository.default_branch == 'main' && github.ref_protected && needs.authorize.result == 'success' && needs.authorize.outputs.environments_verified == 'true' && needs.reader.result == 'success' && needs.test.result == 'success' && needs.validate-result-input.result == 'success' && needs.authorize.outputs.operation == 'collect'";
  assert.deepEqual(Object.keys(job).sort(), ['if', 'needs', 'runs-on', 'environment', 'timeout-minutes', 'permissions', 'steps'].sort());
  assert.equal(job.if, expression(guard));
  assert.deepEqual(job.needs, ['authorize', 'reader', 'test', 'validate-result-input']);
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job.environment, 'billing-validation-attestation');
  assert.equal(job['timeout-minutes'], 10);
  assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' });
  assert.deepEqual(job.steps, [
    { name: 'Checkout exact triggering workflow SHA',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { ref: expression('github.sha'), 'persist-credentials': false } },
    { name: 'Set up Node.js 22', uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': '22', 'package-manager-cache': false } },
    { name: 'Download sanitized financial result input',
      uses: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
      with: { name: 'billing-45-result-input', path: expression('runner.temp') } },
    { name: 'Compose canonical financial result subject',
      env: {
        CONTROL_REPOSITORY: expression('github.repository'),
        CONTROL_REPOSITORY_ID: expression('github.repository_id'),
        CONTROL_REF: expression('github.ref'),
        CONTROL_DEFAULT_BRANCH: expression('github.event.repository.default_branch'),
        CONTROL_REF_PROTECTED: expression('github.ref_protected'),
        CONTROL_WORKFLOW_REF: expression('github.workflow_ref'),
        CONTROL_RUN_ID: expression('github.run_id'),
        CONTROL_RUN_ATTEMPT: expression('github.run_attempt'),
        CONTROL_WORKFLOW_SHA: expression('github.sha'),
        CONTROL_EVENT_NAME: expression('github.event_name'),
        CANDIDATE_SHA: expression('needs.authorize.outputs.candidate_sha'),
        READER_CANDIDATE_SHA: expression('needs.reader.outputs.candidate_sha'),
        READER_CANDIDATE_TREE_SHA: expression('needs.reader.outputs.candidate_tree_sha'),
        CANDIDATE_PULL_NUMBER: expression('needs.reader.outputs.candidate_pull_number'),
        VERCEL_READ_ONLY_TOKEN: expression('secrets.BILLING_VALIDATION_VERCEL_READ_ONLY_TOKEN'),
        BILLING_RESULT_INPUT_PATH: expression('runner.temp') + '/billing-45-result-input.json',
        BILLING_RESULT_MANIFEST_PATH: expression('runner.temp') + '/billing-result-manifest.json',
      },
      run: 'node runner/write-billing-result-manifest.mjs' },
    { name: 'Attest only the canonical financial result subject',
      uses: 'actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d',
      with: { 'subject-path': expression('runner.temp') + '/billing-result-manifest.json' } },
    { name: 'Upload only the financial result subject',
      uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      with: { name: 'billing-result-manifest', path: expression('runner.temp') + '/billing-result-manifest.json',
        'if-no-files-found': 'error', 'retention-days': 1, overwrite: false, 'include-hidden-files': false } },
  ]);
}

function assertResultInputValidationBoundary(job) {
  const expression = value => '${{ ' + value + ' }}';
  const guard = "!cancelled() && github.event_name == 'workflow_dispatch' && github.repository == 'lawxcompany-stack/billing-validation-control' && github.repository_id == '1384018279' && github.ref == 'refs/heads/main' && github.event.repository.default_branch == 'main' && github.ref_protected && needs.authorize.result == 'success' && needs.authorize.outputs.environments_verified == 'true' && needs.reader.result == 'success' && needs.test.result == 'success' && needs.authorize.outputs.operation == 'collect'";
  assert.deepEqual(Object.keys(job).sort(), ['if', 'needs', 'runs-on', 'timeout-minutes', 'permissions', 'steps'].sort());
  assert.equal(job.if, expression(guard));
  assert.deepEqual(job.needs, ['authorize', 'reader', 'test']);
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job.environment, undefined);
  assert.equal(job['timeout-minutes'], 10);
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.deepEqual(job.steps, [
    { name: 'Checkout exact triggering workflow SHA',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { ref: expression('github.sha'), 'persist-credentials': false } },
    { name: 'Set up Node.js 22', uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': '22', 'package-manager-cache': false } },
    { name: 'Download financial result records',
      uses: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
      with: { name: 'billing-45-result-input', path: expression('runner.temp') } },
    { name: 'Validate exact sanitized 45-case result schema before credentials',
      env: { BILLING_RESULT_INPUT_PATH: expression('runner.temp') + '/billing-45-result-input.json' },
      run: 'node runner/validate-billing-result-input.mjs' },
  ]);
}

function assertResultVerificationBoundary(job) {
  const expression = value => '${{ ' + value + ' }}';
  const guard = "!cancelled() && github.event_name == 'workflow_dispatch' && github.repository == 'lawxcompany-stack/billing-validation-control' && github.repository_id == '1384018279' && github.ref == 'refs/heads/main' && github.event.repository.default_branch == 'main' && github.ref_protected && needs.authorize.result == 'success' && needs.authorize.outputs.environments_verified == 'true' && needs.reader.result == 'success' && needs.test.result == 'success' && needs.attest-result.result == 'success' && needs.authorize.outputs.operation == 'collect'";
  assert.deepEqual(Object.keys(job).sort(), ['if', 'needs', 'runs-on', 'timeout-minutes', 'permissions', 'steps'].sort());
  assert.equal(job.if, expression(guard));
  assert.deepEqual(job.needs, ['authorize', 'reader', 'test', 'attest-result']);
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job['timeout-minutes'], 10);
  assert.deepEqual(job.permissions, { contents: 'read', attestations: 'read' });
  assert.deepEqual(job.steps, [
    { name: 'Checkout exact triggering workflow SHA',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { ref: expression('github.sha'), 'persist-credentials': false } },
    { name: 'Set up Node.js 22', uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': '22', 'package-manager-cache': false } },
    { name: 'Download canonical financial result subject',
      uses: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
      with: { name: 'billing-result-manifest', path: expression('runner.temp') } },
    { name: 'Verify financial result attestation before publisher Environment',
      env: {
        GH_TOKEN: expression('github.token'),
        CONTROL_REPOSITORY: expression('github.repository'),
        CONTROL_REPOSITORY_ID: expression('github.repository_id'),
        CONTROL_REF: expression('github.ref'),
        CONTROL_DEFAULT_BRANCH: expression('github.event.repository.default_branch'),
        CONTROL_REF_PROTECTED: expression('github.ref_protected'),
        CONTROL_WORKFLOW_REF: expression('github.workflow_ref'),
        CONTROL_RUN_ID: expression('github.run_id'),
        CONTROL_RUN_ATTEMPT: expression('github.run_attempt'),
        CONTROL_WORKFLOW_SHA: expression('github.sha'),
        CONTROL_EVENT_NAME: expression('github.event_name'),
        CANDIDATE_SHA: expression('needs.authorize.outputs.candidate_sha'),
        READER_CANDIDATE_SHA: expression('needs.reader.outputs.candidate_sha'),
        READER_CANDIDATE_TREE_SHA: expression('needs.reader.outputs.candidate_tree_sha'),
        CANDIDATE_PULL_NUMBER: expression('needs.reader.outputs.candidate_pull_number'),
        BILLING_RESULT_MANIFEST_PATH: expression('runner.temp') + '/billing-result-manifest.json',
      },
      run: 'node runner/verify-billing-result.mjs' },
  ]);
}

// Closed structural contract independent of the YAML being checked. Exact keys,
// commands and expressions also cover bracket/toJSON credential exfiltration and
// job/step defaults, containers, paths, shell or conditional execution bypasses.
function assertLocalAuthorizationBoundary(workflow) {
  const guard = "github.event_name == 'workflow_dispatch' && github.repository == 'lawxcompany-stack/billing-validation-control' && github.repository_id == '1384018279' && github.ref == 'refs/heads/main' && github.event.repository.default_branch == 'main' && github.ref_protected";
  const expression = text => '${{ ' + text + ' }}';
  const setup = () => [
    { name: 'Checkout exact triggering workflow SHA',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { ref: '${{ github.sha }}', 'persist-credentials': false } },
    { name: 'Set up Node.js 22', uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': '22', 'package-manager-cache': false } },
  ];
  const context = {
    CONTROL_REPOSITORY: '${{ github.repository }}', CONTROL_REPOSITORY_ID: '${{ github.repository_id }}',
    CONTROL_REF: '${{ github.ref }}', CONTROL_DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}',
    CONTROL_REF_PROTECTED: '${{ github.ref_protected }}', CONTROL_EVENT_NAME: '${{ github.event_name }}',
    CONTROL_WORKFLOW_REF: '${{ github.workflow_ref }}', CONTROL_WORKFLOW_SHA: '${{ github.workflow_sha }}',
    CONTROL_SHA: '${{ github.sha }}', CONTROL_RUN_ID: '${{ github.run_id }}', CONTROL_RUN_ATTEMPT: '${{ github.run_attempt }}',
  };
  const stringInput = description => ({ description, required: true, type: 'string' });
  assert.deepEqual(workflow, {
    name: 'Authorize local collector',
    on: { workflow_dispatch: { inputs: {
      candidate_sha: stringInput('Full lowercase candidate commit SHA'),
      execution_id: stringInput('Local challenge execution ID'),
      activation_commitment: stringInput('Local challenge activation commitment'),
      suite: { description: 'Authorization suite', required: true, type: 'choice', options: ['billing-43', 'billing-3ds-15'] },
    } } },
    permissions: { contents: 'read' },
    jobs: {
      authorize: {
        if: expression(guard), 'runs-on': 'ubuntu-latest', 'timeout-minutes': 5, permissions: { contents: 'read' },
        outputs: { dispatch: '${{ steps.authorize.outputs.dispatch }}' },
        steps: [...setup(), { name: 'Authorize dispatch and require a reviewed release', id: 'authorize',
          env: { ...context, DISPATCH_INPUTS: '${{ toJSON(inputs) }}' }, run: 'node scripts/authorize-local-collector.mjs' }],
      },
      reader: {
        if: expression(guard + " && needs.authorize.result == 'success'"), needs: 'authorize', 'runs-on': 'ubuntu-latest',
        environment: 'billing-validation-reader', 'timeout-minutes': 10, permissions: { contents: 'read' },
        outputs: { receipt: '${{ steps.candidate.outputs.receipt }}' },
        steps: [...setup(), {
          name: 'Create candidate metadata reader token', id: 'reader_token',
          uses: 'actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349',
          with: { 'app-id': '${{ vars.BILLING_READER_APP_ID }}', 'private-key': '${{ secrets.BILLING_READER_APP_PRIVATE_KEY }}',
            owner: 'lawxcompany-stack', repositories: 'Plataforma-LawX', 'permission-actions': 'read',
            'permission-contents': 'read', 'permission-pull-requests': 'read', 'skip-token-revoke': false },
        }, { name: 'Read exact candidate and prerequisite CI jobs', id: 'candidate',
          env: { ...context, DISPATCH_INPUTS: '${{ needs.authorize.outputs.dispatch }}',
            CANDIDATE_READ_TOKEN: '${{ steps.reader_token.outputs.token }}' }, run: 'node scripts/read-local-authorization-candidate.mjs' }],
      },
      'attest-activation': {
        if: expression(guard + " && needs.authorize.result == 'success' && needs.reader.result == 'success'"),
        needs: ['authorize', 'reader'], 'runs-on': 'ubuntu-latest', environment: 'billing-validation-attestation',
        'timeout-minutes': 10, permissions: { contents: 'read', 'id-token': 'write', attestations: 'write' },
        steps: [...setup(), { name: 'Compose canonical local authorization subject',
          env: { ...context, DISPATCH_INPUTS: '${{ needs.authorize.outputs.dispatch }}',
            CANDIDATE_RECEIPT: '${{ needs.reader.outputs.receipt }}', RUNNER_TEMP: '${{ runner.temp }}' },
          run: 'node scripts/write-local-authorization.mjs',
        }, { name: 'Attest only the canonical local authorization subject',
          uses: 'actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d',
          with: { 'subject-path': '${{ runner.temp }}/local-collector-authorization.json' },
        }, { name: 'Upload only the canonical local authorization subject',
          uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
          with: { name: 'local-collector-authorization', path: '${{ runner.temp }}/local-collector-authorization.json',
            'if-no-files-found': 'error', 'retention-days': 1, overwrite: false, 'include-hidden-files': false },
        }],
      },
    },
  });
}

function workflowConfigurationStrings(workflow) {
  const configuration = structuredClone(workflow);
  delete configuration.name;
  delete configuration['run-name'];
  for (const job of Object.values(configuration.jobs ?? {})) {
    delete job.name;
    for (const step of job.steps ?? []) delete step.name;
  }
  for (const event of Object.values(configuration.on ?? {})) {
    for (const input of Object.values(event.inputs ?? {})) delete input.description;
  }

  const strings = [];
  function visit(value) {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(configuration);
  return strings;
}

function assertNoProviderRuntimeEnvironment(workflow, path) {
  const blocked = /^(?:DATABASE_URL|POSTGRES(?:_|$)|SUPABASE(?:_|$)|STRIPE(?:_|$)|VERCEL_(?:ACCESS_TOKEN|API_TOKEN|TOKEN)(?:_|$))/iu;
  const providerReferences = /\$\{\{\s*(?:vars|secrets)\.([A-Za-z_][A-Za-z0-9_]*)/giu;
  const environments = [['workflow', workflow.env]];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    environments.push([jobId, job.env], ...(job.steps ?? []).map((step) => [jobId, step.env]));
  }
  for (const [scope, environment] of environments) {
    for (const [key, value] of Object.entries(environment ?? {})) {
      assert.ok(!blocked.test(key), `${path}:${scope} must not import provider runtime configuration`);
      if (typeof value === 'string') {
        for (const [, name] of value.matchAll(providerReferences)) {
          assert.ok(!blocked.test(name), `${path}:${scope} must not import provider runtime configuration`);
        }
      }
      if (scope === 'workflow' && typeof value === 'string') {
        assert.ok(!/\$\{\{[^}]*\bsecrets\b[^}]*\}\}/iu.test(value),
          `${path}:workflow env must not import secrets`);
      }
    }
  }
}

export function assertWorkflowSecretBoundary(workflow, path) {
  // A workflow may not import local credentials or select a Production/Live
  // source through executable/configuration values. Presentation labels do not
  // choose a credential source or destination.
  const configurationStrings = workflowConfigurationStrings(workflow);
  assert.ok(!configurationStrings.some((value) => /\.env\.local\b/iu.test(value)),
    `${path} must not load local credentials`);
  assert.ok(!configurationStrings.some((value) => /(?:^|[^a-z0-9])(?:production|prod|live)(?:$|[^a-z0-9])/iu.test(value)),
    `${path} must not select Production or Live credentials or destinations`);
  assert.ok(!configurationStrings.some((value) => /\b(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]*\.supabase\.co\b/iu.test(value)),
    `${path} must not import a Supabase destination`);
  assert.ok(!configurationStrings.some((value) => /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|sqlserver|mssql)(?:\+[a-z0-9_-]+)?:\/\/[^\s"'<>]+/iu.test(value)),
    `${path} must not import a database URL`);
  assert.ok(!configurationStrings.some((value) => /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u.test(value)),
    `${path} must not import a JWT credential`);
  assert.ok(!configurationStrings.some((value) => /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}\b/iu.test(value)),
    `${path} must not import a Supabase API key`);
  assert.ok(!configurationStrings.some((value) => /\b[rs]k_(?:test|live)_[A-Za-z0-9_-]{8,}\b/iu.test(value)),
    `${path} must not import a Stripe secret or restricted API key`);
  assert.ok(!configurationStrings.some((value) => /\bwhsec_[A-Za-z0-9_]{8,}\b/u.test(value)),
    `${path} must not import a Stripe webhook secret`);
  assertNoProviderRuntimeEnvironment(workflow, path);
  if (path === workflowPaths[2]) return assertLocalAuthorizationBoundary(workflow);
  assert.deepEqual(workflow.permissions, { contents: 'read' }, `${path} must keep token permissions read-only`);

  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    const serializedJob = JSON.stringify(job);
    if (path === workflowPaths[0] && jobId === 'reader') assertReaderBoundary(job);
    else if (path === workflowPaths[0] && jobId === 'attest-result') {
      assert.deepEqual(serializedJob.match(/\$\{\{[^}]*\bsecrets\b[^}]*\}\}/gu),
        ['${{ secrets.BILLING_VALIDATION_VERCEL_READ_ONLY_TOKEN }}'],
        `${path}:${jobId} may consume only the scoped Vercel read-only token`);
    } else assert.ok(!/\$\{\{[^}]*\bsecrets\b/i.test(serializedJob),
      `${path}:${jobId} must not consume reader or financial secrets`);
    assert.ok(!/\$\{\{\s*needs\.[^}]+\.outputs\.(?:private_key|token|secret)/i.test(serializedJob),
      `${path}:${jobId} must not propagate credential-like outputs`);
    if (path === workflowPaths[0] && jobId === 'attest-activation') {
      assert.deepEqual(job.permissions, {
        contents: 'read',
        'id-token': 'write',
        attestations: 'write',
      }, `${path}:${jobId} must scope signing permissions to the hosted activation attestation`);
    } else if (path === workflowPaths[0] && jobId === 'attest-result') {
      assertResultAttestationBoundary(job);
    } else if (path === workflowPaths[0] && jobId === 'validate-result-input') {
      assertResultInputValidationBoundary(job);
    } else if (path === workflowPaths[0] && jobId === 'verify-result') {
      assertResultVerificationBoundary(job);
    } else if (path === workflowPaths[0] && jobId === 'publisher') {
      assert.deepEqual(job.permissions, { contents: 'read' },
        'publisher must not retain verification permissions or credentials');
      assert.match(job.if, /needs\.verify-result\.result\s*==\s*'success'/);
      assert.match(job.if, /needs\.attest-result\.result\s*==\s*'success'/);
      assert.match(job.if, /needs\.authorize\.outputs\.operation\s*==\s*'collect'/);
      assert.equal(job.environment, 'billing-validation-publisher');
      assert.equal((serializedJob.match(/\$\{\{\s*github\.token\s*\}\}/gu) ?? []).length, 0);
    } else if (path === workflowPaths[0] && jobId === 'authorize') {
      assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' },
        'only the hosted, secret-free authorization job may read Environment configuration');
      assert.equal(job.environment, undefined);
      assert.equal(job['runs-on'], 'ubuntu-latest');
    } else {
      assert.ok(!job.permissions || JSON.stringify(job.permissions) === JSON.stringify({ contents: 'read' }),
        `${path}:${jobId} must not widen token permissions`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const path of workflowPaths) assertWorkflowSecretBoundary(YAML.parse(readFileSync(path, 'utf8')), path);
  console.log('Static workflow secret-boundary checks passed');
}
