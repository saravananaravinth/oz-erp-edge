import fs from 'node:fs';
import path from 'node:path';

const root = path.join(process.cwd(), 'src');
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(absolute);
  }
}
walk(root);

const fileSet = new Set(files.map((file) => path.normalize(file)));
const graph = new Map();
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gu;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const dependencies = [];
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier?.startsWith('.')) continue;
    const candidates = [
      path.normalize(path.resolve(path.dirname(file), specifier.replace(/\.js$/u, '.ts'))),
      path.normalize(path.resolve(path.dirname(file), specifier, 'index.ts')),
    ];
    const target = candidates.find((candidate) => fileSet.has(candidate));
    if (target !== undefined) dependencies.push(target);
  }
  graph.set(path.normalize(file), dependencies);
}

const visiting = new Set();
const visited = new Set();
const stack = [];

function visit(file) {
  if (visited.has(file)) return;
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    const cycle = [...stack.slice(start), file]
      .map((item) => path.relative(process.cwd(), item).replaceAll(path.sep, '/'))
      .join(' -> ');
    throw new Error(`TypeScript dependency cycle detected: ${cycle}`);
  }
  visiting.add(file);
  stack.push(file);
  for (const dependency of graph.get(file) ?? []) visit(dependency);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}

for (const file of files) visit(path.normalize(file));
console.log('No local TypeScript dependency cycles detected.');
