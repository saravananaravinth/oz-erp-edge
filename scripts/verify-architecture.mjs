import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourceRoot = path.join(root, 'src');
const requiredFiles = [
  'src/apps/worker/worker.entrypoint.ts',
  'src/apps/worker/worker.app.ts',
  'src/config/worker-env.schema.ts',
  'src/gateway/routing/route-contract.ts',
  'src/gateway/proxy/edge-proxy.handler.ts',
  'src/infrastructure/google/cloud-run-id-token.provider.ts',
  'src/operations/health/health.controller.ts',
  'src/observability/request-telemetry.middleware.ts',
];
const forbiddenFiles = [
  'src/index.ts',
  'src/config.ts',
  'src/cors.ts',
  'src/gcp-id-token.ts',
  'src/health.ts',
  'src/origin-policy.ts',
  'src/problem.ts',
  'src/proxy.ts',
  'src/request-context.ts',
  'src/route-policy.ts',
  'src/security.ts',
];
const genericNames = new Set([
  'config.ts',
  'proxy.ts',
  'health.ts',
  'security.ts',
  'utils.ts',
  'helpers.ts',
  'common.ts',
  'manager.ts',
  'handler.ts',
]);
const maxLines = 500;

function fail(message) {
  console.error(`Architecture violation: ${message}`);
  process.exitCode = 1;
}

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) fail(`missing canonical file ${file}`);
}
for (const file of forbiddenFiles) {
  if (fs.existsSync(path.join(root, file))) fail(`legacy file must be removed: ${file}`);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

const files = walk(sourceRoot).filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gu;

for (const file of files) {
  const relative = path.relative(root, file).replaceAll(path.sep, '/');
  const basename = path.basename(file);
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/u).length;
  if (genericNames.has(basename)) fail(`${relative} uses a forbidden generic filename`);
  if (lines > maxLines) fail(`${relative} has ${lines} lines; maximum is ${maxLines}`);

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier?.startsWith('.')) continue;
    const resolved = path.normalize(
      path.join(path.dirname(file), specifier.replace(/\.js$/u, '.ts')),
    );
    const target = path.relative(sourceRoot, resolved).replaceAll(path.sep, '/');
    const sourceLayer = path.relative(sourceRoot, file).replaceAll(path.sep, '/').split('/')[0];
    const targetLayer = target.split('/')[0];

    if (sourceLayer === 'shared' && targetLayer !== 'shared') {
      fail(`${relative} imports ${specifier}; shared may import only shared`);
    }
    if (sourceLayer === 'config' && !['config', 'shared'].includes(targetLayer)) {
      fail(`${relative} imports ${specifier}; config may import only config/shared`);
    }
    if (
      sourceLayer === 'infrastructure' &&
      !['infrastructure', 'config', 'shared'].includes(targetLayer)
    ) {
      fail(
        `${relative} imports ${specifier}; infrastructure may import only infrastructure/config/shared`,
      );
    }
    if (sourceLayer === 'gateway' && !['gateway', 'config', 'shared'].includes(targetLayer)) {
      fail(`${relative} imports ${specifier}; gateway may import only gateway/config/shared`);
    }
  }
}

const wrangler = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
if (!wrangler.includes('"main": "src/apps/worker/worker.entrypoint.ts"')) {
  fail('wrangler.jsonc must use the canonical Worker entrypoint');
}

if (process.exitCode === undefined) {
  console.log('Architecture boundaries, canonical paths, naming, and file-size checks passed.');
}
