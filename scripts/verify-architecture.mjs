// oz-erp-edge/scripts/verify-architecture.mjs
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

function parseJsonc(source) {
  let withoutComments = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (current === '\n') {
        lineComment = false;
        withoutComments += current;
      }
      continue;
    }

    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      } else if (current === '\n') {
        withoutComments += '\n';
      }
      continue;
    }

    if (inString) {
      withoutComments += current;
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      withoutComments += current;
      continue;
    }

    if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }

    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }

    withoutComments += current;
  }

  let normalized = '';
  inString = false;
  escaped = false;

  for (let index = 0; index < withoutComments.length; index += 1) {
    const current = withoutComments[index];

    if (inString) {
      normalized += current;
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      normalized += current;
      continue;
    }

    if (current === ',') {
      let lookahead = index + 1;
      while (/\s/u.test(withoutComments[lookahead] ?? '')) lookahead += 1;
      if (withoutComments[lookahead] === '}' || withoutComments[lookahead] === ']') continue;
    }

    normalized += current;
  }

  return JSON.parse(normalized);
}

function csvSet(value) {
  return new Set(
    String(value ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
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

const wranglerSource = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
const wrangler = parseJsonc(wranglerSource);
if (wrangler.main !== 'src/apps/worker/worker.entrypoint.ts') {
  fail('wrangler.jsonc must use the canonical Worker entrypoint');
}

const observability = wrangler.observability;
if (observability?.enabled !== true) fail('Worker observability must remain enabled');
if (observability?.redact_query_string !== true) {
  fail('Worker observability must redact query strings');
}
if (observability?.logs?.enabled !== true) fail('Workers Logs must remain enabled');
if (observability?.logs?.invocation_logs !== false) {
  fail('production invocation logs must remain disabled');
}
if (observability?.logs?.head_sampling_rate !== 0.1) {
  fail('Workers Logs head sampling rate must remain 0.1');
}
if (observability?.traces?.enabled !== true) fail('Workers traces must remain enabled');
if (observability?.traces?.head_sampling_rate !== 0.01) {
  fail('Workers trace head sampling rate must remain 0.01');
}
if (observability?.propagation_policy === 'accept') {
  fail('unauthenticated inbound trace propagation must not be globally accepted');
}

const allowedMethods = csvSet(wrangler.vars?.ALLOWED_METHODS);
for (const method of ['get', 'head', 'post', 'put', 'patch', 'delete', 'options']) {
  if (!allowedMethods.has(method)) fail(`ALLOWED_METHODS is missing ${method.toUpperCase()}`);
}

const allowedHeaders = csvSet(wrangler.vars?.ALLOWED_HEADERS);
for (const header of ['authorization', 'content-type', 'idempotency-key', 'traceparent']) {
  if (!allowedHeaders.has(header)) fail(`ALLOWED_HEADERS is missing ${header}`);
}

if (process.exitCode === undefined) {
  console.log('Architecture, routing, and observability policy checks passed.');
}
