// oz-erp-edge/generate-bundles.mjs

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const EXPECTED_REPOSITORY_NAME = 'oz-erp-edge';
const DEFAULT_OUTPUT_DIRECTORY = 'bundles';
const BUNDLE_FILE_NAME = 'oz-erp-edge-project.md';
const BUNDLE_SCHEMA_VERSION = 3;
const BUNDLE_FORMAT = 'ozotec-project-source-v1';
const HEADER_SCAN_LIMIT = 16;

const LEGACY_GENERATED_BUNDLE_FILE_NAMES = Object.freeze([
  'oz-erp-edge-apps.md',
  'oz-erp-edge-config.md',
  'oz-erp-edge-gateway.md',
  'oz-erp-edge-infrastructure.md',
  'oz-erp-edge-observability.md',
  'oz-erp-edge-operations.md',
  'oz-erp-edge-root.md',
  'oz-erp-edge-shared.md',
  'oz-erp-edge-src-root.md',
  'oz-erp-edge-structure.md',
  'oz-erp-edge-tests.md',
  'oz-erp-edge-bundles.manifest.json',
]);

const GENERATED_BUNDLE_FILE_NAMES = new Set([
  BUNDLE_FILE_NAME,
  ...LEGACY_GENERATED_BUNDLE_FILE_NAMES,
]);

const GENERATED_LOCK_FILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

const GENERATED_CONTENT_PATHS = new Set(['src/worker-configuration.d.ts']);

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.bmp',
  '.bz2',
  '.class',
  '.dll',
  '.dmg',
  '.doc',
  '.docx',
  '.eot',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.jks',
  '.keystore',
  '.mov',
  '.mp3',
  '.mp4',
  '.otf',
  '.p12',
  '.pdf',
  '.pfx',
  '.png',
  '.so',
  '.tar',
  '.tif',
  '.tiff',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.zip',
]);

const SENSITIVE_TEXT_EXTENSIONS = new Set(['.key', '.pem']);

const SAFE_SECRET_TEMPLATE_MARKER = /(?:^|[._-])(?:dist|example|sample|template)(?:[._-]|$)/u;

function parseArgs(argv) {
  const result = {
    outDir: DEFAULT_OUTPUT_DIRECTORY,
    expectedHead: null,
    relativePathMode: 'generate',
    requireClean: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--out') {
      const value = argv[index + 1];

      if (value === undefined || value.trim().length === 0) {
        throw new Error('--out requires a non-empty directory.');
      }

      result.outDir = value;
      index += 1;
      continue;
    }

    if (argument === '--expected-head') {
      const value = argv[index + 1];

      if (value === undefined || !/^[0-9a-f]{40}$/u.test(value)) {
        throw new Error('--expected-head requires a full 40-character lowercase Git SHA.');
      }

      result.expectedHead = value;
      index += 1;
      continue;
    }

    if (argument === '--require-clean') {
      result.requireClean = true;
      continue;
    }

    if (argument === '--fix-relative-paths' || argument === '--check-relative-paths') {
      const requestedMode =
        argument === '--fix-relative-paths' ? 'fix-relative-paths' : 'check-relative-paths';

      if (result.relativePathMode !== 'generate') {
        throw new Error('--fix-relative-paths and --check-relative-paths are mutually exclusive.');
      }

      result.relativePathMode = requestedMode;
      continue;
    }

    if (argument === '--help' || argument === '-h') {
      process.stdout.write(
        [
          'Usage:',
          '  node generate-bundles.mjs [options]',
          '',
          'Options:',
          '  --out <dir>',
          `      Output directory. Default: ${DEFAULT_OUTPUT_DIRECTORY}`,
          '',
          '  --expected-head <sha>',
          '      Fail unless HEAD equals the supplied full Git SHA.',
          '',
          '  --require-clean',
          '      Fail bundle generation when relevant tracked/untracked working-tree changes exist.',
          '      Header check/fix modes do not require a clean working tree.',
          '',
          '  --check-relative-paths',
          '      Read-only validation of canonical source path headers.',
          '      This mode is safe to run on a dirty working tree.',
          '',
          '  --fix-relative-paths',
          '      Preflight and repair supported source path headers in place.',
          '      Existing non-header edits, newline conventions, and file modes are preserved.',
          '      This mode is safe to run on a dirty working tree and does not generate bundles.',
          '',
          '  -h, --help',
          '      Show this help.',
          '',
          `Bundle generation writes one Project Source file: ${BUNDLE_FILE_NAME}.`,
          'The bundle embeds repository/commit/branch/worktree/content-hash metadata.',
          'Generation reads current on-disk tracked contents and includes non-ignored',
          'untracked files. Binary content, generated lockfiles, generated Cloudflare',
          'type output, generated bundle artifacts, and sensitive local files are not',
          'embedded as source content.',
          '',
        ].join('\n'),
      );

      process.exit(0);
    }

    throw new Error(`Unsupported argument: ${argument}`);
  }

  return result;
}

function runGit(args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
  });
}

function runGitNullSeparated(args) {
  const output = execFileSync('git', [...args, '-z'], {
    cwd: process.cwd(),
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
  });

  return output
    .toString('utf8')
    .split('\0')
    .filter((value) => value.length > 0);
}

function assertRepositoryIdentity(expectedHead) {
  const repoRoot = runGit(['rev-parse', '--show-toplevel']).trim();

  if (resolve(repoRoot) !== resolve(process.cwd())) {
    throw new Error(`Run this generator from the repository root: ${repoRoot}`);
  }

  const repoName = basename(repoRoot);

  if (repoName !== EXPECTED_REPOSITORY_NAME) {
    throw new Error(
      `Expected repository directory "${EXPECTED_REPOSITORY_NAME}", received "${repoName}".`,
    );
  }

  const head = runGit(['rev-parse', 'HEAD']).trim();

  if (!/^[0-9a-f]{40}$/u.test(head)) {
    throw new Error('Unable to resolve a valid Git HEAD.');
  }

  if (expectedHead !== null && expectedHead !== head) {
    throw new Error(`HEAD mismatch. Expected ${expectedHead}, received ${head}.`);
  }

  const commitTimestamp = runGit(['show', '-s', '--format=%cI', 'HEAD']).trim();

  if (commitTimestamp.length === 0) {
    throw new Error('Unable to resolve the HEAD commit timestamp.');
  }

  const branchValue = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const branch = branchValue === 'HEAD' || branchValue.length === 0 ? null : branchValue;

  return {
    repoRoot,
    head,
    shortHead: head.slice(0, 12),
    branch,
    commitTimestamp,
  };
}

function listTrackedFiles() {
  const deletedPaths = new Set(runGitNullSeparated(['ls-files', '--deleted']));

  return runGitNullSeparated(['ls-files', '--cached'])
    .filter((path) => !deletedPaths.has(path))
    .sort(comparePaths);
}

function listUntrackedFiles() {
  return runGitNullSeparated(['ls-files', '--others', '--exclude-standard']).sort(comparePaths);
}

function outputRepositoryPrefix(repoRoot, outDir) {
  const outputDirectory = resolve(outDir);
  const repositoryRelative = relative(repoRoot, outputDirectory);

  if (repositoryRelative.length === 0) {
    return '';
  }

  if (
    isAbsolute(repositoryRelative) ||
    repositoryRelative === '..' ||
    repositoryRelative.startsWith(`..${sep}`)
  ) {
    return null;
  }

  return assertCanonicalRepositoryRelativePath(repositoryRelative);
}

function listRepositorySourceFiles(trackedFiles, untrackedFiles, generatedOutputPrefix) {
  return [...new Set([...trackedFiles, ...untrackedFiles])]
    .map((path) => assertCanonicalRepositoryRelativePath(path))
    .filter((path) => !isGeneratedBundlePath(path, generatedOutputPrefix))
    .sort(comparePaths);
}

function inspectWorkingTree(untrackedFiles, generatedOutputPrefix) {
  const deletedTrackedPaths = new Set(
    runGitNullSeparated(['ls-files', '--deleted'])
      .map((path) => assertCanonicalRepositoryRelativePath(path))
      .filter((path) => !isGeneratedBundlePath(path, generatedOutputPrefix)),
  );

  const changedTrackedPaths = runGitNullSeparated(['diff', 'HEAD', '--name-only'])
    .map((path) => assertCanonicalRepositoryRelativePath(path))
    .filter((path) => !isGeneratedBundlePath(path, generatedOutputPrefix));

  const relevantUntrackedPaths = untrackedFiles
    .map((path) => assertCanonicalRepositoryRelativePath(path))
    .filter((path) => !isGeneratedBundlePath(path, generatedOutputPrefix));

  return {
    dirty: changedTrackedPaths.length > 0 || relevantUntrackedPaths.length > 0,
    changedTrackedFileCount: changedTrackedPaths.length,
    deletedTrackedFileCount: changedTrackedPaths.filter((path) => deletedTrackedPaths.has(path))
      .length,
    untrackedFileCount: relevantUntrackedPaths.length,
  };
}

function comparePaths(left, right) {
  return left.localeCompare(right, 'en', {
    numeric: true,
    sensitivity: 'case',
  });
}

function normalizeRepositoryPath(path) {
  return path.replaceAll('\\', '/');
}

function assertCanonicalRepositoryRelativePath(path) {
  const normalized = normalizeRepositoryPath(path);

  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    throw new Error(`Invalid repository-relative path: ${path}`);
  }

  const segments = normalized.split('/');

  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`Repository-relative path is not canonical: ${path}`);
  }

  return normalized;
}

function isGeneratedBundlePath(path, generatedOutputPrefix = null) {
  const normalized = normalizeRepositoryPath(path);

  if (
    normalized === DEFAULT_OUTPUT_DIRECTORY ||
    normalized.startsWith(`${DEFAULT_OUTPUT_DIRECTORY}/`) ||
    GENERATED_BUNDLE_FILE_NAMES.has(basename(normalized))
  ) {
    return true;
  }

  if (
    generatedOutputPrefix !== null &&
    generatedOutputPrefix.length > 0 &&
    (normalized === generatedOutputPrefix || normalized.startsWith(`${generatedOutputPrefix}/`))
  ) {
    return true;
  }

  return false;
}

function isGeneratedContentPath(path) {
  return GENERATED_CONTENT_PATHS.has(normalizeRepositoryPath(path));
}

function isBinaryExtension(path) {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

function hasBinaryContent(path) {
  const data = readFileSync(path);
  const inspectionLength = Math.min(data.length, 16_384);

  for (let index = 0; index < inspectionLength; index += 1) {
    if (data[index] === 0) {
      return true;
    }
  }

  return false;
}

function hasSafeSecretTemplateMarker(fileName) {
  return SAFE_SECRET_TEMPLATE_MARKER.test(fileName.toLowerCase());
}

function sensitiveBundlePathReason(repositoryPath) {
  const normalized = normalizeRepositoryPath(repositoryPath);
  const fileName = basename(normalized);
  const lowerName = fileName.toLowerCase();
  const extension = extname(lowerName);
  const isSafeTemplate = hasSafeSecretTemplateMarker(lowerName);

  if ((lowerName === '.env' || lowerName.startsWith('.env.')) && !isSafeTemplate) {
    return 'environment-secret-file';
  }

  if ((lowerName === '.dev.vars' || lowerName.startsWith('.dev.vars.')) && !isSafeTemplate) {
    return 'cloudflare-local-secret-file';
  }

  if (lowerName === '.npmrc' || lowerName === '.pypirc') {
    return 'package-registry-credential-file';
  }

  if (!isSafeTemplate && /^(?:credentials|secrets)(?:\.(?:json|ya?ml|toml))?$/u.test(lowerName)) {
    return 'credential-or-secret-file';
  }

  if (!isSafeTemplate && /^(?:gcp-)?service-account(?:-key)?\.(?:json|ya?ml)$/u.test(lowerName)) {
    return 'service-account-key-file';
  }

  if (SENSITIVE_TEXT_EXTENSIONS.has(extension)) {
    return 'private-key-or-certificate-material';
  }

  if (
    extension === '.p12' ||
    extension === '.pfx' ||
    extension === '.jks' ||
    extension === '.keystore'
  ) {
    return 'private-key-or-keystore-material';
  }

  return null;
}

function relativePathExemptionReason(repositoryPath) {
  const normalized = normalizeRepositoryPath(repositoryPath);
  const fileName = basename(normalized);
  const extension = extname(normalized).toLowerCase();

  if (isGeneratedBundlePath(normalized)) {
    return 'generated-bundle-artifact';
  }

  if (isGeneratedContentPath(normalized)) {
    return 'generated-content-file';
  }

  if (GENERATED_LOCK_FILE_NAMES.has(fileName)) {
    return 'generated-lock-file';
  }

  if (sensitiveBundlePathReason(normalized) !== null) {
    return 'sensitive-local-file';
  }

  if (isBinaryExtension(normalized)) {
    return 'binary-file';
  }

  if (extension === '.json' || extension === '.webmanifest') {
    return 'strict-json';
  }

  if (fileName === '.nvmrc' || fileName === '.node-version') {
    return 'toolchain-literal-file';
  }

  if (fileName === 'LICENSE' || fileName.startsWith('LICENSE.')) {
    return 'license-text';
  }

  return null;
}

function isHashCommentFile(path) {
  const fileName = basename(path);

  return (
    fileName === '.dockerignore' ||
    fileName === '.gitignore' ||
    fileName === '.gitattributes' ||
    fileName === '.prettierignore' ||
    fileName === '.eslintignore' ||
    fileName === '.npmignore' ||
    fileName === '.editorconfig' ||
    fileName === 'Makefile' ||
    fileName.startsWith('.env') ||
    fileName.startsWith('.dev.vars') ||
    fileName.startsWith('Dockerfile') ||
    normalizedPublicHeadersPath(path) ||
    normalizedPublicRedirectsPath(path)
  );
}

function normalizedPublicHeadersPath(path) {
  return normalizeRepositoryPath(path) === 'public/_headers';
}

function normalizedPublicRedirectsPath(path) {
  return normalizeRepositoryPath(path) === 'public/_redirects';
}

function firstPhysicalLine(rawContent) {
  const content = rawContent.startsWith('\uFEFF') ? rawContent.slice(1) : rawContent;
  const match = /^(.*?)(?:\r\n|\n|\r|$)/u.exec(content);

  return match?.[1] ?? '';
}

function isNodeShebang(line) {
  return /^#!.*(?:^|[\s/])(?:node|nodejs|bun|deno)(?:[\s\0]|$)/u.test(line);
}

function isShellShebang(line) {
  return /^#!.*(?:^|[\s/])(?:sh|bash|dash|zsh|ksh)(?:[\s\0]|$)/u.test(line);
}

function headerPolicyFor(repositoryPath, rawContent) {
  const normalized = assertCanonicalRepositoryRelativePath(repositoryPath);
  const fileName = basename(normalized);
  const extension = extname(normalized).toLowerCase();
  const firstLine = firstPhysicalLine(rawContent);

  if (
    extension === '.ts' ||
    extension === '.tsx' ||
    extension === '.js' ||
    extension === '.jsx' ||
    extension === '.mjs' ||
    extension === '.cjs' ||
    extension === '.jsonc'
  ) {
    return {
      commentStyle: 'slash',
      preamble: 'interpreter-shebang',
    };
  }

  if (
    extension === '.sh' ||
    extension === '.bash' ||
    extension === '.zsh' ||
    extension === '.ksh' ||
    extension === '.ps1'
  ) {
    return {
      commentStyle: 'hash',
      preamble: 'interpreter-shebang',
    };
  }

  if (isNodeShebang(firstLine)) {
    return {
      commentStyle: 'slash',
      preamble: 'interpreter-shebang',
    };
  }

  if (isShellShebang(firstLine)) {
    return {
      commentStyle: 'hash',
      preamble: 'interpreter-shebang',
    };
  }

  if (fileName.startsWith('Dockerfile')) {
    return {
      commentStyle: 'hash',
      preamble: 'docker-directives',
    };
  }

  if (extension === '.svg' || extension === '.xml') {
    return {
      commentStyle: 'html',
      preamble: 'xml-declaration',
    };
  }

  if (extension === '.md' || extension === '.mdx' || extension === '.html') {
    return {
      commentStyle: 'html',
      preamble: 'ordinary',
    };
  }

  if (extension === '.css' || extension === '.scss' || extension === '.less') {
    return {
      commentStyle: 'block',
      preamble: 'ordinary',
    };
  }

  if (extension === '.sql') {
    return {
      commentStyle: 'sql',
      preamble: 'ordinary',
    };
  }

  if (
    extension === '.yml' ||
    extension === '.yaml' ||
    extension === '.toml' ||
    extension === '.graphql' ||
    extension === '.gql' ||
    extension === '.py' ||
    extension === '.rb' ||
    isHashCommentFile(normalized)
  ) {
    return {
      commentStyle: 'hash',
      preamble: 'ordinary',
    };
  }

  return null;
}

function canonicalHeaderFor(repositoryPath, commentStyle) {
  const canonicalPath = `${EXPECTED_REPOSITORY_NAME}/${assertCanonicalRepositoryRelativePath(
    repositoryPath,
  )}`;

  switch (commentStyle) {
    case 'slash':
      return `// ${canonicalPath}`;

    case 'hash':
      return `# ${canonicalPath}`;

    case 'html':
      return `<!-- ${canonicalPath} -->`;

    case 'block':
      return `/* ${canonicalPath} */`;

    case 'sql':
      return `-- ${canonicalPath}`;

    default:
      throw new Error(`Unsupported relative-path comment style: ${commentStyle}`);
  }
}

function splitDocument(rawContent) {
  const hasBom = rawContent.startsWith('\uFEFF');
  const content = hasBom ? rawContent.slice(1) : rawContent;
  const lines = [];
  let offset = 0;

  while (offset < content.length) {
    let end = offset;

    while (end < content.length && content[end] !== '\n' && content[end] !== '\r') {
      end += 1;
    }

    let eol = '';

    if (end < content.length) {
      if (content[end] === '\r' && content[end + 1] === '\n') {
        eol = '\r\n';
      } else {
        eol = content[end];
      }
    }

    lines.push({
      text: content.slice(offset, end),
      eol,
    });

    offset = end + eol.length;
  }

  return {
    hasBom,
    lines,
  };
}

function renderDocument(document) {
  return `${document.hasBom ? '\uFEFF' : ''}${document.lines
    .map((line) => `${line.text}${line.eol}`)
    .join('')}`;
}

function preferredEol(lines) {
  return lines.find((line) => line.eol.length > 0)?.eol ?? '\n';
}

function insertLine(lines, index, text) {
  const updated = lines.map((line) => ({
    ...line,
  }));

  const eol = preferredEol(updated);

  if (updated.length === 0) {
    updated.push({
      text,
      eol: '',
    });

    return updated;
  }

  if (index < updated.length) {
    updated.splice(index, 0, {
      text,
      eol,
    });

    return updated;
  }

  const previous = updated.at(-1);

  if (previous === undefined) {
    throw new Error('Unable to resolve insertion location.');
  }

  if (previous.eol.length === 0) {
    previous.eol = eol;

    updated.push({
      text,
      eol: '',
    });
  } else {
    updated.push({
      text,
      eol: previous.eol,
    });
  }

  return updated;
}

function unwrapPathHeader(line) {
  const patterns = [
    /^#!(oz-[A-Za-z0-9._-]+\/.+)$/u,
    /^\/\/\s+(.+)$/u,
    /^#\s+(.+)$/u,
    /^<!--\s+(.+?)\s+-->$/u,
    /^\/\*\s+(.+?)\s+\*\/$/u,
    /^--\s+(.+)$/u,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(line);
    const payload = match?.[1]?.trim();

    if (payload !== undefined && payload.length > 0) {
      return payload;
    }
  }

  return null;
}

function classifyPathHeaderPayload(payload, repositoryPath) {
  const normalizedPath = normalizeRepositoryPath(repositoryPath);
  const canonical = `${EXPECTED_REPOSITORY_NAME}/${normalizedPath}`;

  if (payload === canonical) {
    return 'same-repository';
  }

  if (payload === normalizedPath || payload === `./${normalizedPath}`) {
    return 'legacy-exact';
  }

  if (payload.startsWith(`${EXPECTED_REPOSITORY_NAME}/`)) {
    return 'same-repository-stale';
  }

  if (/^oz-[A-Za-z0-9._-]+\//u.test(payload)) {
    return 'different-repository';
  }

  return null;
}

function isDockerParserDirective(line) {
  return /^#\s*(?:syntax|escape|check)\s*=/iu.test(line);
}

function insertionIndexFor(policy, lines) {
  if (policy.preamble === 'interpreter-shebang') {
    return lines[0]?.text.startsWith('#!') === true ? 1 : 0;
  }

  if (policy.preamble === 'docker-directives') {
    let index = 0;

    while (index < lines.length && isDockerParserDirective(lines[index].text)) {
      index += 1;
    }

    return index;
  }

  if (policy.preamble === 'xml-declaration') {
    return /^\s*<\?xml\b.*\?>\s*$/u.test(lines[0]?.text ?? '') ? 1 : 0;
  }

  return 0;
}

function analyzeRelativePathFile(repositoryPath) {
  const normalizedPath = assertCanonicalRepositoryRelativePath(repositoryPath);
  const exemptionReason = relativePathExemptionReason(normalizedPath);

  if (exemptionReason !== null) {
    return {
      kind: 'exempt',
      path: normalizedPath,
      reason: exemptionReason,
    };
  }

  let stat;

  try {
    stat = lstatSync(resolve(normalizedPath));
  } catch (error) {
    return {
      kind: 'unsafe',
      path: normalizedPath,
      reason: 'file-stat-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (stat.isSymbolicLink()) {
    return {
      kind: 'unsafe',
      path: normalizedPath,
      reason: 'repository-symlink',
      detail: 'Repository symlinks are not rewritten or bundled as source content.',
    };
  }

  if (!stat.isFile()) {
    return {
      kind: 'unsafe',
      path: normalizedPath,
      reason: 'not-regular-file',
      detail: 'Expected a regular repository file.',
    };
  }

  if (hasBinaryContent(normalizedPath)) {
    return {
      kind: 'exempt',
      path: normalizedPath,
      reason: 'binary-content',
    };
  }

  const rawContent = readFileSync(normalizedPath, 'utf8');
  const policy = headerPolicyFor(normalizedPath, rawContent);

  if (policy === null) {
    return {
      kind: 'unsafe',
      path: normalizedPath,
      reason: 'unsupported-text-format',
      detail:
        'No semantics-preserving first-line comment syntax is configured for this repository text file.',
    };
  }

  const expectedHeader = canonicalHeaderFor(normalizedPath, policy.commentStyle);
  const document = splitDocument(rawContent);
  const scanLength = Math.min(document.lines.length, HEADER_SCAN_LIMIT);
  const sameRepositoryHeaderIndices = [];
  const differentRepositoryHeaders = [];

  for (let index = 0; index < scanLength; index += 1) {
    const payload = unwrapPathHeader(document.lines[index].text);

    if (payload === null) {
      continue;
    }

    const classification = classifyPathHeaderPayload(payload, normalizedPath);

    if (
      classification === 'same-repository' ||
      classification === 'same-repository-stale' ||
      classification === 'legacy-exact'
    ) {
      sameRepositoryHeaderIndices.push(index);
    } else if (classification === 'different-repository') {
      differentRepositoryHeaders.push({
        index,
        payload,
      });
    }
  }

  if (differentRepositoryHeaders.length > 0) {
    return {
      kind: 'unsafe',
      path: normalizedPath,
      reason: 'different-repository-header',
      detail: `Found ${differentRepositoryHeaders
        .map((entry) => JSON.stringify(entry.payload))
        .join(', ')} in the source preamble.`,
    };
  }

  const remainingLines = document.lines
    .filter((_line, index) => !sameRepositoryHeaderIndices.includes(index))
    .map((line) => ({
      ...line,
    }));

  const targetIndex = insertionIndexFor(policy, remainingLines);

  if (
    sameRepositoryHeaderIndices.length === 1 &&
    sameRepositoryHeaderIndices[0] === targetIndex &&
    document.lines[targetIndex]?.text === expectedHeader
  ) {
    return {
      kind: 'ok',
      path: normalizedPath,
      expectedHeader,
      placement: policy.preamble,
    };
  }

  let repairedLines;

  if (sameRepositoryHeaderIndices.length === 1 && sameRepositoryHeaderIndices[0] === targetIndex) {
    repairedLines = document.lines.map((line) => ({
      ...line,
    }));

    repairedLines[targetIndex].text = expectedHeader;
  } else {
    repairedLines = insertLine(remainingLines, targetIndex, expectedHeader);
  }

  const repairedContent = renderDocument({
    hasBom: document.hasBom,
    lines: repairedLines,
  });

  if (repairedContent === rawContent) {
    return {
      kind: 'ok',
      path: normalizedPath,
      expectedHeader,
      placement: policy.preamble,
    };
  }

  return {
    kind: 'repair',
    path: normalizedPath,
    reason:
      sameRepositoryHeaderIndices.length === 0
        ? 'missing-relative-path-header'
        : sameRepositoryHeaderIndices.length > 1
          ? 'duplicate-relative-path-headers'
          : 'legacy-or-misplaced-relative-path-header',
    expectedHeader,
    placement: policy.preamble,
    repairedContent,
    originalMode: stat.mode & 0o7777,
  };
}

function analyzeRepositoryRelativePaths(repositoryFiles) {
  return repositoryFiles.map((path) => analyzeRelativePathFile(path));
}

function formatRelativePathFailures(results, operation) {
  const failures = results.filter((result) => result.kind === 'repair' || result.kind === 'unsafe');

  const displayed = failures.slice(0, 100);

  const lines = [
    `Relative-path ${operation} failed for ${failures.length} repository file(s).`,
    '',
  ];

  for (const result of displayed) {
    lines.push(`- ${result.path}`);
    lines.push(`  status: ${result.kind}`);
    lines.push(`  reason: ${result.reason}`);

    if ('expectedHeader' in result) {
      lines.push(`  expected: ${JSON.stringify(result.expectedHeader)}`);
    }

    if ('placement' in result) {
      lines.push(`  placement: ${result.placement}`);
    }

    if ('detail' in result) {
      lines.push(`  detail: ${result.detail}`);
    }
  }

  if (failures.length > displayed.length) {
    lines.push('', `...and ${failures.length - displayed.length} additional failure(s).`);
  }

  return lines.join('\n');
}

function checkRelativePaths(repositoryFiles) {
  const results = analyzeRepositoryRelativePaths(repositoryFiles);

  const failures = results.filter((result) => result.kind === 'repair' || result.kind === 'unsafe');

  if (failures.length > 0) {
    throw new Error(
      `${formatRelativePathFailures(results, 'check')}\n\n` +
        'Run `node generate-bundles.mjs --fix-relative-paths` to repair supported files. ' +
        'Unsafe or unsupported files must be resolved explicitly before retrying.',
    );
  }

  const enforced = results.filter((result) => result.kind === 'ok').length;
  const exempt = results.filter((result) => result.kind === 'exempt').length;

  process.stdout.write(`Relative-path check passed: ${enforced} enforced, ${exempt} exempt.\n`);

  return {
    results,
    enforced,
    exempt,
  };
}

function fixRelativePaths(repositoryFiles) {
  const results = analyzeRepositoryRelativePaths(repositoryFiles);
  const unsafe = results.filter((result) => result.kind === 'unsafe');

  if (unsafe.length > 0) {
    throw new Error(
      `${formatRelativePathFailures(results, 'repair preflight')}\n\n` +
        'No files were written because repair preflight found unsafe or unsupported repository files.',
    );
  }

  const repairs = results.filter((result) => result.kind === 'repair');

  for (const repair of repairs) {
    writeFileSync(repair.path, repair.repairedContent, {
      encoding: 'utf8',
    });

    chmodSync(repair.path, repair.originalMode);
  }

  process.stdout.write(
    [
      '',
      'Relative-path repair completed.',
      `Changed: ${repairs.length} file(s)`,
      `Unchanged: ${results.filter((result) => result.kind === 'ok').length} file(s)`,
      `Exempt: ${results.filter((result) => result.kind === 'exempt').length} file(s)`,
      '',
      repairs.length > 0
        ? 'Review the preserved local edits plus header repairs, run --check-relative-paths, then run repository verification before committing.'
        : 'No changes were required; the repair operation is idempotent.',
      '',
    ].join('\n'),
  );
}

function isTextFile(path) {
  if (isBinaryExtension(path)) {
    return false;
  }

  const stat = lstatSync(resolve(path));

  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to bundle symlink content: ${path}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Expected a regular repository file: ${path}`);
  }

  return !hasBinaryContent(path);
}

function assertNoSensitiveBundlePaths(repositoryFiles) {
  const sensitivePaths = repositoryFiles
    .map((path) => ({
      path,
      reason: sensitiveBundlePathReason(path),
    }))
    .filter((entry) => entry.reason !== null);

  if (sensitivePaths.length === 0) {
    return;
  }

  const lines = [
    `Refusing to generate a Project Source bundle with ${sensitivePaths.length} sensitive file(s):`,
    '',
  ];

  for (const entry of sensitivePaths.slice(0, 100)) {
    lines.push(`- ${entry.path} (${entry.reason})`);
  }

  if (sensitivePaths.length > 100) {
    lines.push(`...and ${sensitivePaths.length - 100} additional sensitive file(s).`);
  }

  lines.push(
    '',
    'Move secrets to ignored local/secret storage or rename documented secret-free templates to',
    'a supported .example/.sample/.template/.dist form before generating the bundle.',
  );

  throw new Error(lines.join('\n'));
}

function selectBundleFiles(repositoryFiles) {
  assertNoSensitiveBundlePaths(repositoryFiles);

  const included = [];
  const excluded = [];

  for (const path of repositoryFiles) {
    if (isGeneratedContentPath(path)) {
      excluded.push({
        path,
        reason: 'generated-content-file',
      });

      continue;
    }

    if (GENERATED_LOCK_FILE_NAMES.has(basename(path))) {
      excluded.push({
        path,
        reason: 'generated-lock-file',
      });

      continue;
    }

    if (isBinaryExtension(path)) {
      excluded.push({
        path,
        reason: 'binary-file',
      });

      continue;
    }

    if (!isTextFile(path)) {
      excluded.push({
        path,
        reason: 'binary-content',
      });

      continue;
    }

    included.push(path);
  }

  return {
    included: included.sort(comparePaths),
    excluded,
  };
}

function createTree(paths, rootLabel) {
  const root = {
    directories: new Map(),
    files: new Set(),
  };

  for (const originalPath of paths) {
    const parts = normalizeRepositoryPath(originalPath)
      .split('/')
      .filter((part) => part.length > 0);

    if (parts.length === 0) {
      continue;
    }

    let node = root;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isFile = index === parts.length - 1;

      if (isFile) {
        node.files.add(part);
        continue;
      }

      let child = node.directories.get(part);

      if (child === undefined) {
        child = {
          directories: new Map(),
          files: new Set(),
        };

        node.directories.set(part, child);
      }

      node = child;
    }
  }

  const lines = [`${rootLabel}/`];

  function appendNode(node, prefix) {
    const directories = [...node.directories.entries()]
      .sort(([left], [right]) => comparePaths(left, right))
      .map(([name, child]) => ({
        kind: 'directory',
        name,
        child,
      }));

    const files = [...node.files].sort(comparePaths).map((name) => ({
      kind: 'file',
      name,
      child: null,
    }));

    const entries = [...directories, ...files];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const isLast = index === entries.length - 1;
      const branch = isLast ? '`-- ' : '|-- ';
      const suffix = entry.kind === 'directory' ? '/' : '';

      lines.push(`${prefix}${branch}${entry.name}${suffix}`);

      if (entry.kind === 'directory') {
        appendNode(entry.child, `${prefix}${isLast ? '    ' : '|   '}`);
      }
    }
  }

  appendNode(root, '');

  return lines.join('\n');
}

function languageFor(path) {
  const fileName = basename(path);
  const extension = extname(path).toLowerCase();

  if (fileName === 'Dockerfile' || fileName.startsWith('Dockerfile.')) {
    return 'dockerfile';
  }

  if (fileName === '.gitignore' || fileName === '.dockerignore') {
    return 'gitignore';
  }

  switch (extension) {
    case '.ts':
      return 'ts';

    case '.tsx':
      return 'tsx';

    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js';

    case '.jsx':
      return 'jsx';

    case '.json':
      return 'json';

    case '.jsonc':
      return 'jsonc';

    case '.yml':
    case '.yaml':
      return 'yaml';

    case '.md':
    case '.mdx':
      return 'md';

    case '.css':
      return 'css';

    case '.scss':
      return 'scss';

    case '.less':
      return 'less';

    case '.html':
      return 'html';

    case '.xml':
    case '.svg':
      return 'xml';

    case '.toml':
      return 'toml';

    case '.sh':
    case '.bash':
    case '.zsh':
    case '.ksh':
      return 'bash';

    case '.ps1':
      return 'powershell';

    case '.sql':
      return 'sql';

    case '.graphql':
    case '.gql':
      return 'graphql';

    case '.py':
      return 'python';

    case '.rb':
      return 'ruby';

    default:
      return 'text';
  }
}

function normalizeBundleTextContent(content) {
  return content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/\s+$/u, '');
}

function markdownFenceFor(content) {
  let longestRun = 0;
  let currentRun = 0;

  for (const character of content) {
    if (character === '`') {
      currentRun += 1;

      if (currentRun > longestRun) {
        longestRun = currentRun;
      }
    } else {
      currentRun = 0;
    }
  }

  return '`'.repeat(Math.max(3, longestRun + 1));
}

function assertSourceHeaderBeforeBundling(repositoryPath) {
  const result = analyzeRelativePathFile(repositoryPath);

  if (result.kind === 'ok' || result.kind === 'exempt') {
    return;
  }

  throw new Error(
    `Repository file "${repositoryPath}" failed source-header validation before bundling: ` +
      `${result.reason}. Run --check-relative-paths for complete diagnostics.`,
  );
}

function renderFileSection(repositoryPath) {
  assertSourceHeaderBeforeBundling(repositoryPath);

  const content = normalizeBundleTextContent(readFileSync(repositoryPath, 'utf8'));
  const fence = markdownFenceFor(content);
  const language = languageFor(repositoryPath);

  return [`### File: ${repositoryPath}`, '', `${fence}${language}`, content, fence].join('\n');
}

function renderBundleBody(repositoryFiles, contentFiles) {
  const tree = createTree(repositoryFiles, EXPECTED_REPOSITORY_NAME);

  const parts = [
    '## Repository tree',
    '',
    '> The tree records all non-ignored repository files considered for this snapshot.',
    '> Binary files, generated lockfiles, and generated Cloudflare type output may appear',
    '> in the tree without their contents being embedded below.',
    '',
    '```text',
    tree,
    '```',
    '',
    '## Source files',
  ];

  for (const file of contentFiles) {
    parts.push('', renderFileSection(file));
  }

  parts.push('');

  return parts.join('\n');
}

function sha256Text(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function repositoryTreeSha256(repositoryFiles) {
  const hash = createHash('sha256');
  const separator = Buffer.from([0]);

  for (const path of repositoryFiles) {
    hash.update(path, 'utf8');
    hash.update(separator);
  }

  return hash.digest('hex');
}

function sourceSnapshotSha256(files) {
  const hash = createHash('sha256');
  const separator = Buffer.from([0]);

  for (const path of files) {
    hash.update(path, 'utf8');
    hash.update(separator);
    hash.update(readFileSync(path));
    hash.update(separator);
  }

  return hash.digest('hex');
}

function summarizeExclusions(excluded) {
  const counts = new Map();

  for (const entry of excluded) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => comparePaths(left, right)),
  );
}

function buildMetadata(input) {
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    format: BUNDLE_FORMAT,

    repository: {
      name: EXPECTED_REPOSITORY_NAME,
      branch: input.repository.branch,
      detachedHead: input.repository.branch === null,
      head: input.repository.head,
      shortHead: input.repository.shortHead,
      commitTimestamp: input.repository.commitTimestamp,
    },

    generation: {
      generatedAt: input.generatedAt,
      generator: 'generate-bundles.mjs',
      nodeVersion: process.version,
      outputFile: BUNDLE_FILE_NAME,
      source: 'current-working-tree-filesystem',
      trackedContent: 'current-on-disk',
      untrackedContent: 'included-when-non-ignored',
      snapshotKind: input.workingTree.dirty ? 'working-tree' : 'clean-head',
    },

    workingTree: {
      dirty: input.workingTree.dirty,
      changedTrackedFileCount: input.workingTree.changedTrackedFileCount,
      deletedTrackedFileCount: input.workingTree.deletedTrackedFileCount,
      untrackedFileCount: input.workingTree.untrackedFileCount,
    },

    source: {
      existingTrackedFileCount: input.trackedFileCount,
      repositoryCandidateFileCount: input.repositoryFileCount,
      repositoryTreeSha256: input.repositoryTreeSha256,
      includedFileCount: input.includedFileCount,
      includedTrackedFileCount: input.includedTrackedFileCount,
      includedUntrackedFileCount: input.includedUntrackedFileCount,
      excludedFileCount: input.excludedFileCount,
      excludedByReason: input.excludedByReason,
      snapshotSha256: input.sourceSnapshotSha256,

      contentFileHeader: {
        required: true,
        format: 'format-aware canonical repository-relative path comment',
        scope: 'source-repository-files',
        enforcedFileCount: input.headerCheck.enforced,
        exemptFileCount: input.headerCheck.exempt,
      },
    },

    bundleBody: {
      bytes: input.bundleBodyBytes,
      sha256: input.bundleBodySha256,
    },
  };
}

function renderProjectBundle(metadata, bundleBody) {
  return [
    '# oz-erp-edge Project Source Bundle',
    '',
    '> Generated for ChatGPT/Ozotec Project Source analysis from the current repository filesystem.',
    '> `repository.head` identifies the Git commit. When `workingTree.dirty` is true,',
    '> bundled source also contains current on-disk tracked edits and non-ignored',
    '> untracked files.',
    '> `source.snapshotSha256` fingerprints the exact embedded source paths and raw file bytes.',
    '> `source.repositoryTreeSha256` fingerprints the repository path inventory represented by',
    '> the tree.',
    '',
    '## Snapshot metadata',
    '',
    '```json',
    JSON.stringify(metadata, null, 2),
    '```',
    '',
    bundleBody,
  ].join('\n');
}

function writeFileAtomically(outputPath, content) {
  const temporaryPath = `${outputPath}.tmp-${String(process.pid)}`;

  try {
    writeFileSync(temporaryPath, content, {
      encoding: 'utf8',
      mode: 0o644,
      flag: 'w',
    });

    renameSync(temporaryPath, outputPath);
    chmodSync(outputPath, 0o644);
  } finally {
    rmSync(temporaryPath, {
      force: true,
    });
  }
}

function removeLegacyGeneratedArtifacts(outputDirectory) {
  const processed = [];

  for (const fileName of LEGACY_GENERATED_BUNDLE_FILE_NAMES) {
    const path = join(outputDirectory, fileName);

    try {
      rmSync(path, {
        force: true,
      });

      processed.push(fileName);
    } catch (error) {
      throw new Error(
        `Unable to remove legacy generated artifact "${path}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return processed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repository = assertRepositoryIdentity(args.expectedHead);

  const generatedOutputPrefix = outputRepositoryPrefix(repository.repoRoot, args.outDir);

  const trackedFiles = listTrackedFiles();
  const untrackedFiles = listUntrackedFiles();

  const repositoryFiles = listRepositorySourceFiles(
    trackedFiles,
    untrackedFiles,
    generatedOutputPrefix,
  );

  if (repositoryFiles.length === 0) {
    throw new Error('The repository contains no non-ignored source files.');
  }

  if (args.relativePathMode === 'check-relative-paths') {
    checkRelativePaths(repositoryFiles);
    return;
  }

  if (args.relativePathMode === 'fix-relative-paths') {
    fixRelativePaths(repositoryFiles);
    return;
  }

  const workingTree = inspectWorkingTree(untrackedFiles, generatedOutputPrefix);

  if (args.requireClean && workingTree.dirty) {
    throw new Error(
      'Bundle generation requires a clean working tree because --require-clean was supplied. ' +
        `Found ${workingTree.changedTrackedFileCount} changed tracked file(s), ` +
        `${workingTree.deletedTrackedFileCount} deleted tracked file(s), and ` +
        `${workingTree.untrackedFileCount} non-ignored untracked file(s).`,
    );
  }

  const headerCheck = checkRelativePaths(repositoryFiles);
  const selection = selectBundleFiles(repositoryFiles);
  const bundleFiles = selection.included;

  if (bundleFiles.length === 0) {
    throw new Error(
      'The repository contains no eligible text files for the Project Source bundle.',
    );
  }

  const trackedFileSet = new Set(trackedFiles);
  const untrackedFileSet = new Set(untrackedFiles);

  const includedTrackedFileCount = bundleFiles.filter((path) => trackedFileSet.has(path)).length;

  const includedUntrackedFileCount = bundleFiles.filter((path) =>
    untrackedFileSet.has(path),
  ).length;

  const bundleBody = renderBundleBody(repositoryFiles, bundleFiles);

  const bundleBodyBytes = Buffer.byteLength(bundleBody, 'utf8');

  const bundleBodySha256 = sha256Text(bundleBody);

  const treeSha256 = repositoryTreeSha256(repositoryFiles);

  const snapshotSha256 = sourceSnapshotSha256(bundleFiles);

  const generatedAt = new Date().toISOString();

  const metadata = buildMetadata({
    repository,
    generatedAt,
    workingTree,
    trackedFileCount: trackedFiles.length,
    repositoryFileCount: repositoryFiles.length,
    repositoryTreeSha256: treeSha256,
    includedFileCount: bundleFiles.length,
    includedTrackedFileCount,
    includedUntrackedFileCount,
    excludedFileCount: selection.excluded.length,
    excludedByReason: summarizeExclusions(selection.excluded),
    sourceSnapshotSha256: snapshotSha256,
    headerCheck,
    bundleBodyBytes,
    bundleBodySha256,
  });

  const content = renderProjectBundle(metadata, bundleBody);

  const outputDirectory = resolve(args.outDir);
  const outputPath = join(outputDirectory, BUNDLE_FILE_NAME);

  const bundleBytes = Buffer.byteLength(content, 'utf8');

  const bundleSha256 = sha256Text(content);

  mkdirSync(outputDirectory, {
    recursive: true,
    mode: 0o755,
  });

  writeFileAtomically(outputPath, content);

  const processedLegacyArtifacts = removeLegacyGeneratedArtifacts(outputDirectory);

  process.stdout.write(
    [
      '',
      'oz-erp-edge Project Source bundle generation completed.',
      '',
      `Repository:      ${EXPECTED_REPOSITORY_NAME}`,
      `Branch:          ${repository.branch ?? '(detached HEAD)'}`,
      `HEAD:            ${repository.head}`,
      `Commit:          ${repository.commitTimestamp}`,
      `Generated:       ${generatedAt}`,
      `Tracked:         ${trackedFiles.length} existing tracked file(s)`,
      `Candidates:      ${repositoryFiles.length} non-ignored repository file(s)`,
      `Included:        ${bundleFiles.length} text file(s) (${includedUntrackedFileCount} untracked)`,
      `Excluded:        ${selection.excluded.length} content file(s)`,
      `Worktree:        ${
        workingTree.dirty
          ? `dirty (${workingTree.changedTrackedFileCount} tracked change(s), ${workingTree.deletedTrackedFileCount} deletion(s), ${workingTree.untrackedFileCount} untracked file(s))`
          : 'clean'
      }`,
      `Headers:         ${headerCheck.enforced} enforced, ${headerCheck.exempt} exempt`,
      `Tree SHA-256:    ${treeSha256}`,
      `Source snapshot: ${snapshotSha256}`,
      `Bundle body:     ${bundleBodySha256}`,
      `Bundle SHA-256:  ${bundleSha256}`,
      `Bundle bytes:    ${bundleBytes}`,
      `Legacy cleanup:  ${processedLegacyArtifacts.length} generated artifact name(s) processed`,
      `Output:          ${relative(process.cwd(), outputPath) || BUNDLE_FILE_NAME}`,
      '',
    ].join('\n'),
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  process.stderr.write(`Bundle generation failed: ${message}\n`);
  process.exitCode = 1;
}
