export const CONTROL_STORE_BOOTSTRAP_PINS = Object.freeze({
  baselineSha256: '830a518ee997f8824657d0a8720b8f8b13c7c91f051d945202b684bfc23739c4',
  migrations: Object.freeze([
    Object.freeze({
      version: '202610010001',
      name: 'standalone-lease-fencing',
      file: '202610010001-standalone-lease-fencing.sql',
      sha256: 'd733038f706135c2514084fc229c9ac7507796cccd4eca4974ca1dc981fd12fb',
    }),
    Object.freeze({
      version: '202610020001',
      name: 'control-runtime-privileges',
      file: '202610020001-control-runtime-privileges.sql',
      sha256: '69fe93ee2a67e8a52588bdb8b235ab88207441f5c85608bc51e791d574347c08',
    }),
    Object.freeze({
      version: '202610030001',
      name: 'control-store-verifier',
      file: '202610030001-control-store-verifier.sql',
      sha256: '56ca6c77487900bbd9affc934665e08f5bc5246e42c1adb9a077d828c8034698',
    }),
    Object.freeze({
      version: '202610040001',
      name: 'control-verifier-role',
      file: '202610040001-control-verifier-role.sql',
      sha256: '40e47a94aaab6e8513133a11896c8338e177588d1bd8278c64779767ea16f267',
    }),
  ]),
});
