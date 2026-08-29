import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const rawNumericStyleProperties = new Set([
  "borderRadius",
  "columnGap",
  "gap",
  "margin",
  "marginBottom",
  "marginEnd",
  "marginHorizontal",
  "marginLeft",
  "marginRight",
  "marginStart",
  "marginTop",
  "marginVertical",
  "padding",
  "paddingBottom",
  "paddingEnd",
  "paddingHorizontal",
  "paddingLeft",
  "paddingRight",
  "paddingStart",
  "paddingTop",
  "paddingVertical",
  "rowGap",
]);

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return componentFiles(path);
    }

    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) {
      return [];
    }

    return [path];
  });
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
    return node.text;
  }

  return undefined;
}

describe("semantic design-token consumption", () => {
  test("keeps functional components free of raw visual token values", () => {
    const projectRoot = process.cwd();
    const files = [
      ...componentFiles(join(projectRoot, "app")),
      ...componentFiles(join(projectRoot, "src")),
    ];
    const violations: string[] = [];

    for (const file of files) {
      const sourceText = readFileSync(file, "utf8");
      const source = ts.createSourceFile(
        file,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );

      const visit = (node: ts.Node) => {
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node)) &&
          /^#[\dA-Fa-f]{3,8}$/.test(node.text)
        ) {
          violations.push(
            `${relative(projectRoot, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} raw color ${node.text}`,
          );
        }

        if (ts.isPropertyAssignment(node)) {
          const name = propertyName(node.name);
          const rawFont =
            name === "fontFamily" &&
            (ts.isStringLiteral(node.initializer) ||
              ts.isNoSubstitutionTemplateLiteral(node.initializer));
          const rawSpacingOrRadius =
            name !== undefined &&
            rawNumericStyleProperties.has(name) &&
            ts.isNumericLiteral(node.initializer);
          const rawDuration =
            name?.toLowerCase().includes("duration") === true &&
            ts.isNumericLiteral(node.initializer);

          if (rawFont || rawSpacingOrRadius || rawDuration) {
            violations.push(
              `${relative(projectRoot, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} raw ${name ?? "visual token"}`,
            );
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(source);
    }

    expect(violations).toEqual([]);
  });
});
