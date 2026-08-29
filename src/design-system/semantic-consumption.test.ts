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

function isLiteralString(node: ts.Node): node is ts.StringLiteralLike {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function isColorStyleProperty(name: string | undefined): boolean {
  return name === "color" || name?.endsWith("Color") === true;
}

function isSignedOrUnsignedNumericLiteral(node: ts.Node): boolean {
  if (ts.isNumericLiteral(node)) {
    return true;
  }

  return (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.PlusToken ||
      node.operator === ts.SyntaxKind.MinusToken) &&
    ts.isNumericLiteral(node.operand)
  );
}

function isRawVisualValue(
  name: string | undefined,
  initializer: ts.Expression,
): boolean {
  const rawColor = isColorStyleProperty(name) && isLiteralString(initializer);
  const rawFont = name === "fontFamily" && isLiteralString(initializer);
  const rawSpacingOrRadius =
    name !== undefined &&
    rawNumericStyleProperties.has(name) &&
    isSignedOrUnsignedNumericLiteral(initializer);
  const rawDuration =
    name?.toLowerCase().includes("duration") === true &&
    isSignedOrUnsignedNumericLiteral(initializer);

  return rawColor || rawFont || rawSpacingOrRadius || rawDuration;
}

type LocalBinding =
  | { readonly found: false }
  | { readonly found: true; readonly initializer?: ts.Expression };

function declarationBinding(
  statement: ts.Statement,
  name: string,
): LocalBinding {
  if (!ts.isVariableStatement(statement)) {
    return { found: false };
  }

  for (
    let index = statement.declarationList.declarations.length - 1;
    index >= 0;
    index -= 1
  ) {
    const declaration = statement.declarationList.declarations[index];

    if (!declaration || !ts.isIdentifier(declaration.name)) {
      continue;
    }

    if (declaration.name.text !== name) {
      continue;
    }

    const isConst =
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;

    if (!isConst || !declaration.initializer) {
      return { found: true };
    }

    return { found: true, initializer: declaration.initializer };
  }

  return { found: false };
}

function directStatement(
  container: ts.Block | ts.SourceFile,
  node: ts.Node,
): ts.Statement | undefined {
  let child = node;

  while (child.parent && child.parent !== container) {
    child = child.parent;
  }

  return child.parent === container && ts.isStatement(child)
    ? child
    : undefined;
}

function localConstBinding(identifier: ts.Identifier): LocalBinding {
  const name = identifier.text;

  for (
    let ancestor: ts.Node | undefined = identifier.parent;
    ancestor;
    ancestor = ancestor.parent
  ) {
    if (
      ts.isFunctionLike(ancestor) &&
      ancestor.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === name,
      )
    ) {
      return { found: true };
    }

    if (!ts.isBlock(ancestor) && !ts.isSourceFile(ancestor)) {
      continue;
    }

    const containingStatement = directStatement(ancestor, identifier);

    if (!containingStatement) {
      continue;
    }

    const statementIndex = ancestor.statements.indexOf(containingStatement);

    for (let index = statementIndex - 1; index >= 0; index -= 1) {
      const statement = ancestor.statements[index];

      if (!statement) {
        continue;
      }

      const binding = declarationBinding(statement, name);

      if (binding.found) {
        return binding;
      }
    }
  }

  return { found: false };
}

function visualTokenViolations(
  sourceText: string,
  file: string,
  displayPath = file,
): string[] {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (isRawVisualValue(name, node.initializer)) {
        violations.push(
          `${displayPath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} raw ${name ?? "visual token"}`,
        );
      }
    }

    if (ts.isShorthandPropertyAssignment(node)) {
      const name = node.name.text;
      const binding = localConstBinding(node.name);

      if (
        binding.found &&
        binding.initializer &&
        isRawVisualValue(name, binding.initializer)
      ) {
        violations.push(
          `${displayPath}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} raw ${name}`,
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return violations;
}

describe("semantic design-token consumption", () => {
  test("rejects raw React Native color strings in color-bearing style properties", () => {
    const violations = visualTokenViolations(
      `
        import { StyleSheet, Text } from "react-native";

        const styles = StyleSheet.create({
          root: {
            backgroundColor: "rgb(10, 20, 30)",
            borderColor: "red",
            color: "rgba(40, 50, 60, 0.8)",
          },
        });

        export function Example() {
          return <Text accessibilityLabel="red">rgb(10, 20, 30)</Text>;
        }
      `,
      "color-mutation.tsx",
    );

    expect(violations).toHaveLength(3);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("raw backgroundColor"),
        expect.stringContaining("raw borderColor"),
        expect.stringContaining("raw color"),
      ]),
    );
  });

  test("rejects signed raw spacing values", () => {
    const violations = visualTokenViolations(
      `
        import { StyleSheet } from "react-native";

        export const styles = StyleSheet.create({
          root: { marginTop: -8, padding: +12 },
        });
      `,
      "signed-spacing-mutation.tsx",
    );

    expect(violations).toHaveLength(2);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("raw marginTop"),
        expect.stringContaining("raw padding"),
      ]),
    );
  });

  test("rejects shorthand visual properties bound to local raw constants", () => {
    const violations = visualTokenViolations(
      `
        import { View } from "react-native";

        export function Example() {
          const padding = 12;
          return <View style={{ padding }} />;
        }
      `,
      "shorthand-spacing-mutation.tsx",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("raw padding");
  });

  test("allows semantic token references and dynamic component values", () => {
    const violations = visualTokenViolations(
      `
        import { View } from "react-native";
        import { spacing, useCrewRollTheme } from "./index";

        export function Example({
          opacity,
          padding,
        }: {
          opacity: number;
          padding: number;
        }) {
          const colors = useCrewRollTheme();
          const marginTop = spacing.md;
          return (
            <View
              accessibilityLabel="red rgb(10, 20, 30)"
              style={{
                backgroundColor: colors.surface,
                borderColor: colors.border,
                marginTop,
                opacity,
                padding,
              }}
            />
          );
        }
      `,
      "semantic-control.tsx",
    );

    expect(violations).toEqual([]);
  });

  test("keeps functional components free of raw visual token values", () => {
    const projectRoot = process.cwd();
    const files = [
      ...componentFiles(join(projectRoot, "app")),
      ...componentFiles(join(projectRoot, "src")),
    ];
    const violations: string[] = [];

    for (const file of files) {
      const sourceText = readFileSync(file, "utf8");
      violations.push(
        ...visualTokenViolations(sourceText, file, relative(projectRoot, file)),
      );
    }

    expect(violations).toEqual([]);
  });
});
