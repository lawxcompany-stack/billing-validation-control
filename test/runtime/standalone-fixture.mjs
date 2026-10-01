// Synthetic identities only; these are not provisioned or approved provider resources.
export const databasePolicy = Object.freeze({
  kind: 'standalone',
  approved: true,
  projectRef: 'abcdefghijklmnopqrst',
  productionProjectRef: 'zyxwvutsrqponmlkjihg',
  branchProjectRefs: Object.freeze(['zjvqjdntasprusoqfsgw', 'bbbbbbbbbbbbbbbbbbbb']),
  organizationId: 'synthetic-validation-org',
  region: 'synthetic-region-1',
  databaseVersion: '17.6.1.synthetic',
  postgresEngine: 'postgres',
  releaseChannel: 'stable',
  connection: Object.freeze({ mode: 'direct', host: 'db.abcdefghijklmnopqrst.supabase.co',
    port: 5432, database: 'postgres', role: 'billing_validation_reader' }),
  schemaFingerprintSha256: '5fc39c1e3b29e8f9862db2a63503bce26fe470ed383119f52b4979a47fdecb95',
  migrationHistorySha256: 'dc2fea6d8a3cf12df137e8870d263aa3ae3b5ae4f674459ff7b8033b30671f93',
});

export const trustedConfiguration = Object.freeze({
  environmentApproved: true,
  SUPABASE_VALIDATION_PROJECT_REF: databasePolicy.projectRef,
  databaseUrl: 'postgresql://billing_validation_reader:synthetic-password@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
});

export const projectDetails = Object.freeze({
  ref: databasePolicy.projectRef,
  organization_id: databasePolicy.organizationId,
  region: databasePolicy.region,
  status: 'ACTIVE_HEALTHY',
  database: Object.freeze({ version: databasePolicy.databaseVersion,
    postgres_engine: databasePolicy.postgresEngine, release_channel: databasePolicy.releaseChannel }),
});

export const migrations = Object.freeze([
  { version: '202609230002', name: 'billing' }, { version: '202609230001', name: 'init' },
]);
export const generatedTypes = Object.freeze({ types: 'export type Database = { public: true }\n' });
