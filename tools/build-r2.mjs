import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const root = fileURLToPath(new URL('../', import.meta.url));
const gatewayOnly = process.argv.includes('--gateway-only');
const distRoot = path.join(root, 'cloudbase', 'dist');
const gatewayDist = path.join(distRoot, 'gateway');
const webDist = path.join(root, 'apps', 'web', 'dist');
const migration = path.join(root, 'cloudbase', 'migrations', '20261103080337_gq_vtwo_core.sql');

await mkdir(gatewayDist, { recursive: true });
const bundle = await rolldown({
  input: path.join(root, 'cloudbase', 'functions', 'gateway', 'src', 'main.ts'),
  external: ['@cloudbase/node-sdk', 'pg'],
  platform: 'node',
  transform: { target: 'node18' },
});
await bundle.write({
  file: path.join(gatewayDist, 'index.js'),
  format: 'cjs',
  exports: 'named',
});
await bundle.close();
await copyFile(
  path.join(root, 'cloudbase', 'functions', 'gateway', 'package.json'),
  path.join(gatewayDist, 'package.json'),
);

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }));
  return files.flat().sort();
}

if (!gatewayOnly) {
  const forbidden = [
    '__GQ_DEV_FIXTURE__',
    'DEV_FIXTURE',
    'devFixture',
    'dev-token',
    'x-gongqi-dev',
    'VITE_DEV',
    'GQ_WEB_FIXTURE',
    'GQ_TEST_DATABASE_URL',
  ];
  const webFiles = await filesBelow(webDist);
  for (const file of webFiles) {
    const source = await readFile(file, 'utf8');
    const matched = forbidden.filter(token => source.includes(token));
    if (matched.length) {
      throw new Error(`Production web artifact contains development markers: ${matched.join(', ')}`);
    }
  }
  const index = await readFile(path.join(webDist, 'index.html'), 'utf8');
  if (!index.includes('/app/assets/')) throw new Error('Production web artifact is not built for /app/');

  const inputs = [
    migration,
    path.join(root, 'cloudbaserc.json'),
    ...await filesBelow(gatewayDist),
    ...webFiles,
  ];
  const files = await Promise.all(inputs.map(async file => ({
    path: path.relative(root, file).split(path.sep).join('/'),
    bytes: (await stat(file)).size,
    sha256: createHash('sha256').update(await readFile(file)).digest('hex'),
  })));
  const manifest = {
    schemaVersion: 1,
    environment: 'gongqi-dev-d9grxerai94b966a1',
    staticDeployPath: '/app/',
    files,
  };
  await writeFile(
    path.join(distRoot, 'r2-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

console.log(gatewayOnly
  ? 'Gateway bundle written to cloudbase/dist/gateway'
  : 'R2 gateway, web validation and manifest completed');
