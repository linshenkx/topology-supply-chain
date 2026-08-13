import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const productionRoots = [
  "apps/web/app",
  "apps/web/platform",
  "apps/api/src",
  "apps/worker/src",
  "database/runtime",
  "packages/contracts/src",
  "packages/shared-config/src",
];
const extensions = [".ts", ".tsx", ".mts", ".cts"];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(target);
    return extensions.includes(path.extname(entry.name)) && !entry.name.endsWith(".d.ts") ? [target] : [];
  }));
  return nested.flat();
}

const files = (await Promise.all(productionRoots.map((root) => collectFiles(path.join(repositoryRoot, root))))).flat();
const fileSet = new Set(files.map((file) => path.normalize(file)));

function resolveCandidate(candidate) {
  const targets = [candidate, ...extensions.map((extension) => `${candidate}${extension}`), ...extensions.map((extension) => path.join(candidate, `index${extension}`))];
  return targets.map((target) => path.normalize(target)).find((target) => fileSet.has(target));
}

function resolveSpecifier(sourceFile, specifier) {
  if (specifier.startsWith(".")) return resolveCandidate(path.resolve(path.dirname(sourceFile), specifier));
  if (specifier.startsWith("@/")) return resolveCandidate(path.join(repositoryRoot, "apps/web", specifier.slice(2)));
  if (specifier.startsWith("@database/")) return resolveCandidate(path.join(repositoryRoot, "database/runtime", specifier.slice(10)));
  const workspacePackages = new Map([
    ["@topology/contracts", "packages/contracts/src/index"],
    ["@topology/shared-config", "packages/shared-config/src/index"],
  ]);
  return workspacePackages.has(specifier)
    ? resolveCandidate(path.join(repositoryRoot, workspacePackages.get(specifier)))
    : undefined;
}

function runtimeSpecifiers(sourceText, fileName) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const bindings = node.importClause?.namedBindings;
      const typeOnlyNamedImport = bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
      if (!typeOnlyNamedImport && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

const graph = new Map(files.map((file) => [path.normalize(file), new Set()]));
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const specifier of runtimeSpecifiers(source, file)) {
    const target = resolveSpecifier(file, specifier);
    if (target) graph.get(path.normalize(file)).add(target);
  }
}

const databaseRoot = path.normalize(path.join(repositoryRoot, "database")) + path.sep;
const webRoot = path.normalize(path.join(repositoryRoot, "apps/web")) + path.sep;
const reverseEdges = [];
for (const [source, targets] of graph) {
  for (const target of targets) {
    if (source.startsWith(databaseRoot) && target.startsWith(webRoot)) reverseEdges.push([source, target]);
  }
}

const visiting = new Set();
const visited = new Set();
const stack = [];
const cycles = [];
function visit(file) {
  if (visiting.has(file)) {
    cycles.push([...stack.slice(stack.indexOf(file)), file]);
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  stack.push(file);
  for (const target of graph.get(file) ?? []) visit(target);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}
for (const file of files) visit(path.normalize(file));

if (reverseEdges.length || cycles.length) {
  for (const [source, target] of reverseEdges) console.error(`database -> apps/web runtime edge: ${path.relative(repositoryRoot, source)} -> ${path.relative(repositoryRoot, target)}`);
  for (const cycle of cycles) console.error(`runtime cycle: ${cycle.map((file) => path.relative(repositoryRoot, file)).join(" -> ")}`);
  process.exit(1);
}

const edgeCount = [...graph.values()].reduce((total, targets) => total + targets.size, 0);
console.log(`Runtime import graph: ${files.length} files, ${edgeCount} internal edges, cycles=0, database->apps/web=0.`);
