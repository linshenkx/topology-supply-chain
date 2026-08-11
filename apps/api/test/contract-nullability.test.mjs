import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const contractsDirectory = new URL("../../../packages/contracts/src/", import.meta.url);

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

function isNullSchema(node) {
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === "type" &&
      ts.isStringLiteral(property.initializer) &&
      property.initializer.text === "null",
  );
}

test("contract anyOf schemas put null first to prevent serializer coercion", async () => {
  const files = (await readdir(contractsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
  const violations = [];
  let nullableSchemaCount = 0;

  for (const file of files) {
    const sourceText = await readFile(new URL(file, contractsDirectory), "utf8");
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    function visit(node) {
      if (ts.isPropertyAssignment(node) && propertyName(node.name) === "anyOf") {
        const initializer = node.initializer;
        if (ts.isArrayLiteralExpression(initializer)) {
          const nullIndex = initializer.elements.findIndex(isNullSchema);
          if (nullIndex >= 0) {
            nullableSchemaCount += 1;
            if (nullIndex !== 0) {
              const location = source.getLineAndCharacterOfPosition(node.getStart(source));
              violations.push(`${file}:${location.line + 1}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }

  assert.ok(nullableSchemaCount > 0, "expected nullable contract schemas");
  assert.deepEqual(violations, []);
});
