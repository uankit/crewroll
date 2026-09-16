import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

const MIGRATION_ROOT = "services/control-plane/src/db/migrations";
const REFERENTIAL_ACTIONS = new Set([
  "cascade",
  "restrict",
  "set null",
  "set default",
  "no action",
]);
const INDEX_OPERATORS = new Set([
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "is",
  "is not",
]);
const FORBIDDEN_SQL_TOKEN =
  /\b(?:ALTER|CALL|COPY|CREATE|DELETE|DO|DROP|EXECUTE|GRANT|INSERT|LOCK|REINDEX|RENAME|REVOKE|SET|RESET|TRUNCATE|UPDATE|VACUUM)\b/iu;
const DOLLAR_QUOTE = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareFindings(left, right) {
  return (
    compareText(left.path, right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    compareText(left.code, right.code)
  );
}

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function isMissing(error) {
  return (
    error &&
    typeof error === "object" &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function modifiersOf(node) {
  return new Set((node.modifiers ?? []).map(({ kind }) => kind));
}

function hasOnlyModifiers(node, allowedKinds) {
  const actual = modifiersOf(node);
  return (
    actual.size === allowedKinds.length &&
    allowedKinds.every((kind) => actual.has(kind))
  );
}

function hasTypeArguments(call) {
  return Boolean(call.typeArguments);
}

function isDirectString(node) {
  return ts.isStringLiteral(node);
}

function isDirectStringArray(node) {
  return (
    ts.isArrayLiteralExpression(node) &&
    node.elements.length > 0 &&
    node.elements.every((element) => ts.isStringLiteral(element))
  );
}

function isPrimitive(node, allowNegative = false) {
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  return (
    allowNegative &&
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  );
}

function flattenCallChain(expression) {
  if (!ts.isCallExpression(expression)) return null;
  const steps = [];
  let cursor = expression;

  while (ts.isCallExpression(cursor)) {
    if (
      cursor.questionDotToken ||
      !ts.isPropertyAccessExpression(cursor.expression) ||
      cursor.expression.questionDotToken
    ) {
      return null;
    }
    steps.unshift({
      name: cursor.expression.name.text,
      args: [...cursor.arguments],
      typeArguments: [...(cursor.typeArguments ?? [])],
      hasTypeArgumentList: Boolean(cursor.typeArguments),
      node: cursor,
    });
    cursor = cursor.expression.expression;
  }

  if (
    ts.isPropertyAccessExpression(cursor) &&
    !cursor.questionDotToken &&
    ts.isIdentifier(cursor.expression) &&
    cursor.name.text === "schema"
  ) {
    return { root: cursor.expression.text, scope: "schema", steps };
  }
  if (ts.isIdentifier(cursor)) {
    return { root: cursor.text, scope: "direct", steps };
  }
  return null;
}

function locationOf(sourceFile, nodeOrPosition) {
  const position =
    typeof nodeOrPosition === "number"
      ? nodeOrPosition
      : nodeOrPosition.getStart(sourceFile, false);
  const { line, character } =
    sourceFile.getLineAndCharacterOfPosition(position);
  return { line: line + 1, column: character + 1 };
}

function createFindingCollector(sourceFile, relativePath) {
  const findings = [];
  const keys = new Set();
  const add = (nodeOrPosition, code) => {
    const location = locationOf(sourceFile, nodeOrPosition);
    const finding = { code, path: relativePath, ...location };
    const key = `${finding.path}\u0000${finding.line}\u0000${finding.column}\u0000${finding.code}`;
    if (!keys.has(key)) {
      keys.add(key);
      findings.push(finding);
    }
  };
  return { add, findings };
}

function isBoundedSql(node, context) {
  if (
    !ts.isTaggedTemplateExpression(node) ||
    !ts.isIdentifier(node.tag) ||
    node.tag.text !== "sql" ||
    node.typeArguments ||
    !context.sqlBinding ||
    !ts.isNoSubstitutionTemplateLiteral(node.template)
  ) {
    return false;
  }
  const sqlText = node.template.text;
  return !(
    sqlText.includes(";") ||
    sqlText.includes("--") ||
    sqlText.includes("/*") ||
    sqlText.includes("*/") ||
    DOLLAR_QUOTE.test(sqlText) ||
    FORBIDDEN_SQL_TOKEN.test(sqlText)
  );
}

function validateCallbackParameter(
  callback,
  context,
  opaqueCode = "MIGRATION_UP_OPAQUE_CALL",
) {
  if (
    !ts.isArrowFunction(callback) ||
    callback.modifiers?.some(
      ({ kind }) => kind === ts.SyntaxKind.AsyncKeyword,
    ) ||
    callback.typeParameters ||
    callback.parameters.length !== 1 ||
    ts.isBlock(callback.body)
  ) {
    return { code: opaqueCode, node: callback };
  }
  const parameter = callback.parameters[0];
  if (
    !ts.isIdentifier(parameter.name) ||
    parameter.dotDotDotToken ||
    parameter.initializer ||
    parameter.questionToken ||
    parameter.modifiers?.length ||
    parameter.name.text === "db" ||
    parameter.name.text === "sql" ||
    context.functions.has(parameter.name.text)
  ) {
    return { code: "MIGRATION_BINDING_SHAPE", node: parameter };
  }
  return { parameter: parameter.name.text };
}

function validateAlterTableAddColumn(alteration, context, opaqueCode) {
  // Additive nullable timestamps cannot rewrite existing rows. Keep the
  // accepted grammar literal and narrow, just like the existing boolean form.
  if (
    alteration.args.length === 2 &&
    isDirectString(alteration.args[0]) &&
    isDirectString(alteration.args[1]) &&
    alteration.args[1].text === "timestamptz"
  )
    return null;
  if (
    alteration.args.length !== 3 ||
    !isDirectString(alteration.args[0]) ||
    !isDirectString(alteration.args[1]) ||
    !["boolean", "jsonb"].includes(alteration.args[1].text)
  ) {
    return { code: opaqueCode, node: alteration.node };
  }

  const callback = alteration.args[2];
  const parameterResult = validateCallbackParameter(
    callback,
    context,
    opaqueCode,
  );
  if (!parameterResult.parameter) return parameterResult;
  const chain = flattenCallChain(callback.body);
  if (
    !chain ||
    chain.scope !== "direct" ||
    chain.root !== parameterResult.parameter
  ) {
    return { code: "MIGRATION_BINDING_SHAPE", node: callback.body };
  }

  const [notNull, defaultTo] = chain.steps;
  if (
    chain.steps.length !== 2 ||
    notNull.name !== "notNull" ||
    notNull.args.length !== 0 ||
    notNull.hasTypeArgumentList ||
    defaultTo.name !== "defaultTo" ||
    defaultTo.args.length !== 1 ||
    !(alteration.args[1].text === "boolean"
      ? defaultTo.args[0].kind === ts.SyntaxKind.FalseKeyword
      : isBoundedSql(defaultTo.args[0], context) &&
        ts.isNoSubstitutionTemplateLiteral(defaultTo.args[0].template) &&
        defaultTo.args[0].template.text === "'[]'::jsonb") ||
    defaultTo.hasTypeArgumentList
  ) {
    return { code: opaqueCode, node: callback.body };
  }
  return null;
}

function validateAlterColumnDefault(alteration, context, opaqueCode) {
  if (alteration.args.length !== 2 || !isDirectString(alteration.args[0])) {
    return { code: opaqueCode, node: alteration.node };
  }

  const callback = alteration.args[1];
  const parameterResult = validateCallbackParameter(
    callback,
    context,
    opaqueCode,
  );
  if (!parameterResult.parameter) return parameterResult;
  const chain = flattenCallChain(callback.body);
  if (
    !chain ||
    chain.scope !== "direct" ||
    chain.root !== parameterResult.parameter
  ) {
    return { code: "MIGRATION_BINDING_SHAPE", node: callback.body };
  }

  const [setDefault] = chain.steps;
  if (
    chain.steps.length !== 1 ||
    setDefault.name !== "setDefault" ||
    setDefault.args.length !== 1 ||
    !ts.isNumericLiteral(setDefault.args[0]) ||
    !["0", "1"].includes(setDefault.args[0].text) ||
    setDefault.hasTypeArgumentList
  ) {
    return { code: opaqueCode, node: callback.body };
  }
  return null;
}

function validateColumnCallback(callback, context) {
  const parameterResult = validateCallbackParameter(callback, context);
  if (!parameterResult.parameter) return parameterResult;
  const chain = flattenCallChain(callback.body);
  if (
    !chain ||
    chain.scope !== "direct" ||
    chain.root !== parameterResult.parameter ||
    chain.steps.length === 0
  ) {
    return { code: "MIGRATION_BINDING_SHAPE", node: callback.body };
  }

  const seen = new Set();
  let hasReference = false;
  for (const step of chain.steps) {
    if (step.hasTypeArgumentList || seen.has(step.name)) {
      return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
    }
    seen.add(step.name);
    if (
      ["primaryKey", "notNull", "unique", "generatedAlwaysAsIdentity"].includes(
        step.name,
      )
    ) {
      if (step.args.length !== 0)
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
    } else if (step.name === "references") {
      if (step.args.length !== 1 || !isDirectString(step.args[0]))
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      hasReference = true;
    } else if (step.name === "onDelete" || step.name === "onUpdate") {
      if (
        !hasReference ||
        step.args.length !== 1 ||
        !isDirectString(step.args[0]) ||
        !REFERENTIAL_ACTIONS.has(step.args[0].text)
      ) {
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      }
    } else if (step.name === "defaultTo") {
      if (
        step.args.length !== 1 ||
        (!isPrimitive(step.args[0], true) &&
          !isBoundedSql(step.args[0], context))
      ) {
        return {
          code:
            step.args.length === 1 &&
            (ts.isTaggedTemplateExpression(step.args[0]) ||
              ts.isCallExpression(step.args[0]) ||
              ts.isBinaryExpression(step.args[0]))
              ? "MIGRATION_SQL_SHAPE"
              : "MIGRATION_UP_OPAQUE_CALL",
          node: step.args[0] ?? step.node,
        };
      }
    } else if (step.name === "check") {
      if (step.args.length !== 1 || !isBoundedSql(step.args[0], context)) {
        return {
          code: "MIGRATION_SQL_SHAPE",
          node: step.args[0] ?? step.node,
        };
      }
    } else {
      return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
    }
  }
  return null;
}

function validateForeignKeyCallback(callback, context) {
  const parameterResult = validateCallbackParameter(callback, context);
  if (!parameterResult.parameter) return parameterResult;
  const chain = flattenCallChain(callback.body);
  if (
    !chain ||
    chain.scope !== "direct" ||
    chain.root !== parameterResult.parameter ||
    chain.steps.length === 0
  ) {
    return { code: "MIGRATION_BINDING_SHAPE", node: callback.body };
  }
  const seen = new Set();
  for (const step of chain.steps) {
    if (
      step.hasTypeArgumentList ||
      seen.has(step.name) ||
      !["onDelete", "onUpdate"].includes(step.name) ||
      step.args.length !== 1 ||
      !isDirectString(step.args[0]) ||
      !REFERENTIAL_ACTIONS.has(step.args[0].text)
    ) {
      return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
    }
    seen.add(step.name);
  }
  return null;
}

function validateCreateTable(chain, context) {
  const { steps } = chain;
  if (
    steps.length < 3 ||
    steps[0].name !== "createTable" ||
    steps[0].args.length !== 1 ||
    !isDirectString(steps[0].args[0]) ||
    steps.at(-1).name !== "execute" ||
    steps.at(-1).args.length !== 0
  ) {
    return { code: "MIGRATION_UP_OPAQUE_CALL", node: steps[0]?.node };
  }
  let columnCount = 0;
  let methodRank = 0;
  const methodRanks = new Map([
    ["addColumn", 0],
    ["addPrimaryKeyConstraint", 1],
    ["addUniqueConstraint", 2],
    ["addForeignKeyConstraint", 3],
    ["addCheckConstraint", 4],
  ]);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.hasTypeArgumentList) {
      return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
    }
    if (index === 0 || index === steps.length - 1) continue;
    if (step.name === "execute") {
      return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
    }
    const nextMethodRank = methodRanks.get(step.name);
    if (nextMethodRank === undefined || nextMethodRank < methodRank) {
      return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
    }
    methodRank = nextMethodRank;
    if (step.name === "addColumn") {
      columnCount += 1;
      if (
        (step.args.length !== 2 && step.args.length !== 3) ||
        !isDirectString(step.args[0]) ||
        !isDirectString(step.args[1])
      ) {
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      }
      if (step.args.length === 3) {
        const callbackResult = validateColumnCallback(step.args[2], context);
        if (callbackResult) return callbackResult;
      }
    } else if (
      step.name === "addPrimaryKeyConstraint" ||
      step.name === "addUniqueConstraint"
    ) {
      if (
        step.args.length !== 2 ||
        !isDirectString(step.args[0]) ||
        !isDirectStringArray(step.args[1])
      ) {
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      }
    } else if (step.name === "addForeignKeyConstraint") {
      if (
        (step.args.length !== 4 && step.args.length !== 5) ||
        !isDirectString(step.args[0]) ||
        !isDirectStringArray(step.args[1]) ||
        !isDirectString(step.args[2]) ||
        !isDirectStringArray(step.args[3]) ||
        step.args[1].elements.length !== step.args[3].elements.length
      ) {
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      }
      if (step.args.length === 5) {
        const callbackResult = validateForeignKeyCallback(
          step.args[4],
          context,
        );
        if (callbackResult) return callbackResult;
      }
    } else if (step.name === "addCheckConstraint") {
      if (step.args.length !== 2 || !isDirectString(step.args[0])) {
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      }
      if (!isBoundedSql(step.args[1], context)) {
        return {
          code: "MIGRATION_SQL_SHAPE",
          node: step.args[1],
        };
      }
    }
  }
  return columnCount > 0
    ? null
    : { code: "MIGRATION_UP_OPAQUE_CALL", node: steps[0].node };
}

function validatePartialIndexType(columnStep, whereStep) {
  if (
    columnStep.typeArguments.length !== 1 ||
    columnStep.args.length !== 1 ||
    !isDirectString(columnStep.args[0]) ||
    whereStep.args.length !== 3 ||
    !isDirectString(whereStep.args[0])
  ) {
    return false;
  }
  const union = columnStep.typeArguments[0];
  if (!ts.isUnionTypeNode(union) || union.types.length !== 2) return false;
  const [runtimeType, predicateType] = union.types;
  if (
    !ts.isLiteralTypeNode(runtimeType) ||
    !ts.isStringLiteral(runtimeType.literal) ||
    !ts.isLiteralTypeNode(predicateType) ||
    !ts.isStringLiteral(predicateType.literal)
  ) {
    return false;
  }
  return (
    runtimeType.literal.text !== predicateType.literal.text &&
    runtimeType.literal.text === columnStep.args[0].text &&
    predicateType.literal.text === whereStep.args[0].text
  );
}

function validateCreateIndex(chain) {
  const { steps } = chain;
  if (
    steps.length < 4 ||
    steps[0].name !== "createIndex" ||
    steps[0].args.length !== 1 ||
    !isDirectString(steps[0].args[0]) ||
    steps.at(-1).name !== "execute" ||
    steps.at(-1).args.length !== 0
  ) {
    return { code: "MIGRATION_UP_OPAQUE_CALL", node: steps[0]?.node };
  }

  let phase = "created";
  let uniqueCount = 0;
  let onCount = 0;
  let columnMode = null;
  const columnSteps = [];
  const whereSteps = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (index === 0) {
      if (step.hasTypeArgumentList)
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      continue;
    }
    if (index === steps.length - 1) {
      if (step.hasTypeArgumentList || phase === "created")
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      phase = "executed";
      continue;
    }

    if (step.name === "unique") {
      uniqueCount += 1;
      if (
        phase !== "created" ||
        uniqueCount !== 1 ||
        step.args.length !== 0 ||
        step.hasTypeArgumentList
      ) {
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      }
    } else if (step.name === "on") {
      onCount += 1;
      if (
        phase !== "created" ||
        onCount !== 1 ||
        step.args.length !== 1 ||
        !isDirectString(step.args[0]) ||
        step.hasTypeArgumentList
      ) {
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      }
      phase = "on";
    } else if (step.name === "column") {
      if (
        !["on", "columns"].includes(phase) ||
        columnMode === "columns" ||
        step.args.length !== 1 ||
        !isDirectString(step.args[0])
      ) {
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      }
      columnMode = "column";
      columnSteps.push(step);
      phase = "columns";
    } else if (step.name === "columns") {
      if (
        phase !== "on" ||
        columnMode ||
        step.args.length !== 1 ||
        !isDirectStringArray(step.args[0]) ||
        step.hasTypeArgumentList
      ) {
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      }
      columnMode = "columns";
      phase = "columns";
    } else if (step.name === "where") {
      if (
        phase !== "columns" ||
        whereSteps.length !== 0 ||
        step.args.length !== 3 ||
        !isDirectString(step.args[0]) ||
        !isDirectString(step.args[1]) ||
        !INDEX_OPERATORS.has(step.args[1].text) ||
        !isPrimitive(step.args[2]) ||
        step.hasTypeArgumentList
      ) {
        return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
      }
      whereSteps.push(step);
      phase = "where";
    } else {
      return { code: "MIGRATION_UP_OPAQUE_CALL", node: step.node };
    }
  }

  if (onCount !== 1 || !columnMode || phase !== "executed") {
    return { code: "MIGRATION_UP_OPAQUE_CALL", node: steps[0].node };
  }
  const typedColumns = columnSteps.filter(
    ({ hasTypeArgumentList }) => hasTypeArgumentList,
  );
  if (typedColumns.length === 0) return null;
  if (
    typedColumns.length !== 1 ||
    columnSteps.length !== 1 ||
    columnMode !== "column" ||
    whereSteps.length !== 1 ||
    !validatePartialIndexType(typedColumns[0], whereSteps[0])
  ) {
    return { code: "MIGRATION_UP_OPAQUE_CALL", node: typedColumns[0].node };
  }
  return null;
}

function validateAlterTable(chain, context, mode) {
  const { steps } = chain;
  const opaqueCode =
    mode === "up" ? "MIGRATION_UP_OPAQUE_CALL" : "MIGRATION_DOWN_OPAQUE_CALL";
  if (
    steps.length !== 3 ||
    steps[0].name !== "alterTable" ||
    steps[0].args.length !== 1 ||
    !isDirectString(steps[0].args[0]) ||
    steps[0].hasTypeArgumentList ||
    steps[2].name !== "execute" ||
    steps[2].args.length !== 0 ||
    steps[2].hasTypeArgumentList
  ) {
    return { code: opaqueCode, node: steps[0]?.node };
  }

  const alteration = steps[1];
  if (alteration.hasTypeArgumentList) {
    return { code: opaqueCode, node: alteration.node };
  }
  if (alteration.name === "addColumn") {
    return mode === "up"
      ? validateAlterTableAddColumn(alteration, context, opaqueCode)
      : { code: opaqueCode, node: alteration.node };
  }
  if (alteration.name === "alterColumn") {
    return validateAlterColumnDefault(alteration, context, opaqueCode);
  }
  if (alteration.name === "dropColumn") {
    return mode === "down" &&
      alteration.args.length === 1 &&
      isDirectString(alteration.args[0])
      ? null
      : { code: opaqueCode, node: alteration.node };
  }
  if (alteration.name === "dropConstraint") {
    return alteration.args.length === 1 && isDirectString(alteration.args[0])
      ? null
      : { code: opaqueCode, node: alteration.node };
  }
  if (alteration.name === "addCheckConstraint") {
    if (alteration.args.length !== 2 || !isDirectString(alteration.args[0])) {
      return { code: opaqueCode, node: alteration.node };
    }
    return isBoundedSql(alteration.args[1], context)
      ? null
      : { code: "MIGRATION_SQL_SHAPE", node: alteration.args[1] };
  }
  return { code: opaqueCode, node: alteration.node };
}

function validateUpExpression(expression, functionInfo, context) {
  const chain = flattenCallChain(expression);
  if (!chain || chain.root !== functionInfo.parameterName) {
    return { code: "MIGRATION_BINDING_SHAPE", node: expression };
  }
  if (chain.scope !== "schema") {
    return { code: "MIGRATION_UP_OPAQUE_CALL", node: expression };
  }
  if (chain.steps[0]?.name === "createTable") {
    return validateCreateTable(chain, context);
  }
  if (chain.steps[0]?.name === "createIndex") {
    return validateCreateIndex(chain);
  }
  if (chain.steps[0]?.name === "alterTable") {
    return validateAlterTable(chain, context, "up");
  }
  return { code: "MIGRATION_UP_OPAQUE_CALL", node: expression };
}

function validateDownExpression(expression, functionInfo, context) {
  const chain = flattenCallChain(expression);
  if (
    chain &&
    chain.root === functionInfo.parameterName &&
    chain.scope === "schema" &&
    chain.steps[0]?.name === "alterTable"
  ) {
    return validateAlterTable(chain, context, "down");
  }
  if (
    !chain ||
    chain.root !== functionInfo.parameterName ||
    chain.scope !== "schema" ||
    chain.steps.length !== 2 ||
    !["dropIndex", "dropTable"].includes(chain.steps[0].name) ||
    chain.steps[0].args.length !== 1 ||
    !isDirectString(chain.steps[0].args[0]) ||
    chain.steps[0].hasTypeArgumentList ||
    chain.steps[1].name !== "execute" ||
    chain.steps[1].args.length !== 0 ||
    chain.steps[1].hasTypeArgumentList
  ) {
    return { code: "MIGRATION_DOWN_OPAQUE_CALL", node: expression };
  }
  return null;
}

function inspectImport(statement, context) {
  if (
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    statement.assertClause ||
    statement.attributes
  ) {
    context.add(statement, "MIGRATION_IMPORT_SHAPE");
    return;
  }
  const clause = statement.importClause;
  if (!clause) {
    context.add(statement, "MIGRATION_IMPORT_SHAPE");
    return;
  }
  if (clause.isTypeOnly) return;
  const bindings = clause.namedBindings;
  const exactSqlImport =
    !clause.name &&
    statement.moduleSpecifier.text === "kysely" &&
    bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length === 1 &&
    !bindings.elements[0].isTypeOnly &&
    !bindings.elements[0].propertyName &&
    bindings.elements[0].name.text === "sql";
  if (!exactSqlImport || context.sqlBinding) {
    context.add(statement, "MIGRATION_IMPORT_SHAPE");
    return;
  }
  context.sqlBinding = bindings.elements[0].name;
}

function collectFunction(statement, context) {
  if (!statement.name || !ts.isIdentifier(statement.name)) {
    context.add(statement, "MIGRATION_BINDING_SHAPE");
    return;
  }
  const name = statement.name.text;
  if (context.functions.has(name)) {
    context.add(statement.name, "MIGRATION_BINDING_SHAPE");
    return;
  }
  const lifecycle = name === "up" || name === "down";
  const modifiersValid = lifecycle
    ? hasOnlyModifiers(statement, [
        ts.SyntaxKind.ExportKeyword,
        ts.SyntaxKind.AsyncKeyword,
      ])
    : hasOnlyModifiers(statement, [ts.SyntaxKind.AsyncKeyword]);
  const parameter = statement.parameters[0];
  const parameterValid =
    statement.parameters.length === 1 &&
    parameter &&
    ts.isIdentifier(parameter.name) &&
    parameter.name.text === "db" &&
    !parameter.dotDotDotToken &&
    !parameter.initializer &&
    !parameter.questionToken &&
    !parameter.modifiers?.length;
  const signatureValid =
    modifiersValid &&
    (lifecycle || name !== "db") &&
    !statement.asteriskToken &&
    !statement.typeParameters &&
    Boolean(statement.body) &&
    parameterValid;
  if (!signatureValid) {
    context.add(statement, "MIGRATION_BINDING_SHAPE");
  }
  context.functions.set(name, {
    name,
    node: statement,
    body: statement.body,
    parameterName:
      parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : null,
    lifecycle,
    signatureValid,
    edges: new Set(),
    contexts: new Set(),
  });
}

function directAwaitExpression(statement) {
  return ts.isExpressionStatement(statement) &&
    ts.isAwaitExpression(statement.expression)
    ? statement.expression.expression
    : null;
}

function inspectHelperCall(expression, functionInfo, context) {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression)
  )
    return { isHelper: false };
  const target = context.functions.get(expression.expression.text);
  if (!target) return { isHelper: false };
  const valid =
    !expression.questionDotToken &&
    !hasTypeArguments(expression) &&
    !target.lifecycle &&
    expression.arguments.length === 1 &&
    ts.isIdentifier(expression.arguments[0]) &&
    expression.arguments[0].text === functionInfo.parameterName;
  if (!valid) {
    context.add(expression, "MIGRATION_BINDING_SHAPE");
    return { isHelper: true, valid: false };
  }
  functionInfo.edges.add(target.name);
  return { isHelper: true, valid: true };
}

function buildHelperGraph(context) {
  for (const functionInfo of context.functions.values()) {
    if (!functionInfo.body) continue;
    for (const statement of functionInfo.body.statements) {
      const expression = directAwaitExpression(statement);
      if (expression) inspectHelperCall(expression, functionInfo, context);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (name) => {
    if (visiting.has(name)) {
      context.add(context.functions.get(name).node, "MIGRATION_BINDING_SHAPE");
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const target of context.functions.get(name)?.edges ?? [])
      visit(target);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of context.functions.keys()) visit(name);

  const propagate = (name, mode, seen) => {
    const key = `${name}\u0000${mode}`;
    if (seen.has(key)) return;
    seen.add(key);
    const info = context.functions.get(name);
    if (!info) return;
    info.contexts.add(mode);
    for (const target of info.edges) propagate(target, mode, seen);
  };
  const seen = new Set();
  if (context.functions.has("up")) propagate("up", "up", seen);
  if (context.functions.has("down")) propagate("down", "down", seen);

  for (const info of context.functions.values()) {
    if (!info.lifecycle && info.contexts.size === 0) {
      context.add(info.node, "MIGRATION_BINDING_SHAPE");
    }
  }
}

function validateFunctionBody(functionInfo, context) {
  if (!functionInfo.body) return;
  const modes = functionInfo.lifecycle
    ? [functionInfo.name]
    : functionInfo.contexts;
  let returnSeen = false;
  for (let index = 0; index < functionInfo.body.statements.length; index += 1) {
    const statement = functionInfo.body.statements[index];
    if (ts.isReturnStatement(statement) && !statement.expression) {
      if (returnSeen || index !== functionInfo.body.statements.length - 1) {
        context.add(statement, "MIGRATION_BINDING_SHAPE");
      }
      returnSeen = true;
      continue;
    }
    const expression = directAwaitExpression(statement);
    if (!expression) {
      context.add(statement, "MIGRATION_BINDING_SHAPE");
      continue;
    }
    const helper = inspectHelperCall(expression, functionInfo, context);
    if (helper.isHelper) continue;
    for (const mode of modes) {
      const result =
        mode === "up"
          ? validateUpExpression(expression, functionInfo, context)
          : validateDownExpression(expression, functionInfo, context);
      if (result) context.add(result.node ?? expression, result.code);
    }
  }
}

function analyzeSourceFile(sourceFile, relativePath) {
  const collector = createFindingCollector(sourceFile, relativePath);
  if (sourceFile.parseDiagnostics.length > 0) {
    for (const diagnostic of sourceFile.parseDiagnostics) {
      collector.add(diagnostic.start ?? 0, "MIGRATION_PARSE");
    }
    return collector.findings;
  }

  const context = {
    ...collector,
    sourceFile,
    relativePath,
    sqlBinding: null,
    functions: new Map(),
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      inspectImport(statement, context);
    } else if (ts.isFunctionDeclaration(statement)) {
      collectFunction(statement, context);
    } else if (
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement)
    ) {
      if (statement.modifiers?.length) {
        context.add(statement, "MIGRATION_TOP_LEVEL_SHAPE");
      }
    } else if (
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement)
    ) {
      context.add(statement, "MIGRATION_EXPORT_SHAPE");
    } else {
      context.add(statement, "MIGRATION_TOP_LEVEL_SHAPE");
    }
  }

  for (const lifecycleName of ["up", "down"]) {
    if (!context.functions.has(lifecycleName)) {
      context.add(sourceFile, "MIGRATION_EXPORT_SHAPE");
    }
  }
  if (context.sqlBinding && context.functions.has(context.sqlBinding.text)) {
    context.add(
      context.functions.get(context.sqlBinding.text).node,
      "MIGRATION_BINDING_SHAPE",
    );
  }

  buildHelperGraph(context);
  for (const functionInfo of context.functions.values()) {
    validateFunctionBody(functionInfo, context);
  }
  return context.findings;
}

async function readMigrationSource({
  absoluteRoot,
  canonicalRoot,
  relativePath,
  fs,
}) {
  if (
    typeof relativePath !== "string" ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    path.posix.dirname(relativePath) !== MIGRATION_ROOT
  ) {
    return { code: "MIGRATION_TOPOLOGY", sourceText: null };
  }
  const targetPath = path.resolve(absoluteRoot, relativePath);
  if (!isInside(absoluteRoot, targetPath)) {
    return { code: "MIGRATION_TOPOLOGY", sourceText: null };
  }

  const segments = path
    .relative(absoluteRoot, path.dirname(targetPath))
    .split(path.sep)
    .filter(Boolean);
  let ancestor = absoluteRoot;
  for (const segment of segments) {
    ancestor = path.join(ancestor, segment);
    let stats;
    try {
      stats = await fs.lstat(ancestor);
    } catch (error) {
      if (isMissing(error))
        return { code: "MIGRATION_TOPOLOGY", sourceText: null };
      throw error;
    }
    if (stats.isSymbolicLink()) {
      return { code: "MIGRATION_SYMLINK", sourceText: null };
    }
  }

  let stats;
  try {
    stats = await fs.lstat(targetPath);
  } catch (error) {
    if (isMissing(error))
      return { code: "MIGRATION_TOPOLOGY", sourceText: null };
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return { code: "MIGRATION_SYMLINK", sourceText: null };
  }
  if (!stats.isFile()) {
    return { code: "MIGRATION_TOPOLOGY", sourceText: null };
  }
  const canonicalTarget = await fs.realpath(targetPath);
  if (!isInside(canonicalRoot, canonicalTarget)) {
    return { code: "MIGRATION_SYMLINK", sourceText: null };
  }
  try {
    return { code: null, sourceText: await fs.readFile(targetPath, "utf8") };
  } catch (error) {
    if (isMissing(error))
      return { code: "MIGRATION_TOPOLOGY", sourceText: null };
    throw error;
  }
}

export async function analyzeMigrationModules({
  rootPath,
  migrationFiles,
  fsAdapter,
} = {}) {
  const fs = fsAdapter ?? { lstat, readFile, realpath };
  if (
    typeof rootPath !== "string" ||
    rootPath.length === 0 ||
    !Array.isArray(migrationFiles) ||
    typeof fs?.lstat !== "function" ||
    typeof fs?.readFile !== "function" ||
    typeof fs?.realpath !== "function"
  ) {
    throw new TypeError("Invalid migration analyzer input");
  }

  const absoluteRoot = path.resolve(rootPath);
  const rootStats = await fs.lstat(absoluteRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new TypeError("Invalid migration analyzer root");
  }
  const canonicalRoot = await fs.realpath(absoluteRoot);
  const findings = [];
  const findingKeys = new Set();
  const append = (finding) => {
    const key = `${finding.path}\u0000${finding.line}\u0000${finding.column}\u0000${finding.code}`;
    if (!findingKeys.has(key)) {
      findingKeys.add(key);
      findings.push(finding);
    }
  };

  for (const relativePath of migrationFiles) {
    const safeFindingPath =
      typeof relativePath === "string" &&
      !path.posix.isAbsolute(relativePath) &&
      !relativePath.includes("\\") &&
      path.posix.normalize(relativePath) === relativePath &&
      path.posix.dirname(relativePath) === MIGRATION_ROOT
        ? relativePath
        : MIGRATION_ROOT;
    const loaded = await readMigrationSource({
      absoluteRoot,
      canonicalRoot,
      relativePath,
      fs,
    });
    if (loaded.code) {
      append({
        code: loaded.code,
        path: safeFindingPath,
        line: 1,
        column: 1,
      });
      continue;
    }
    const sourceFile = ts.createSourceFile(
      relativePath,
      loaded.sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const finding of analyzeSourceFile(sourceFile, relativePath)) {
      append(finding);
    }
  }

  return deepFreeze({
    migrationCount: migrationFiles.length,
    findings: findings.sort(compareFindings),
  });
}
