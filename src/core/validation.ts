export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export type UnknownRecord = Record<string, unknown>;

export class CoreValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "CoreValidationError";
    this.issues = issues;
  }
}

export function parseSuccess<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function parseFailure<T = never>(
  issues: readonly ValidationIssue[],
): ParseResult<T> {
  return { ok: false, issues };
}

export function issue(
  path: string,
  code: string,
  message: string,
): ValidationIssue {
  return { path, code, message };
}

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(
  value: UnknownRecord,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function requireRecord(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): UnknownRecord | undefined {
  if (!isUnknownRecord(value)) {
    issues.push(issue(path, "INVALID_TYPE", "Expected an object."));
    return undefined;
  }
  return value;
}

export function rejectUnknownKeys(
  value: UnknownRecord,
  allowedKeys: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push(
        issue(joinPath(path, key), "UNKNOWN_FIELD", "Unexpected field."),
      );
    }
  }
}

export interface StringRules {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly requireTrimmed?: boolean;
}

export function readString(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
  rules: StringRules = {},
): string | undefined {
  const fieldPath = joinPath(path, key);
  if (!hasOwn(value, key)) {
    issues.push(issue(fieldPath, "REQUIRED", "Field is required."));
    return undefined;
  }

  const candidate = value[key];
  if (typeof candidate !== "string") {
    issues.push(issue(fieldPath, "INVALID_TYPE", "Expected a string."));
    return undefined;
  }
  if (rules.requireTrimmed && candidate !== candidate.trim()) {
    issues.push(
      issue(fieldPath, "NOT_TRIMMED", "Leading or trailing whitespace is not allowed."),
    );
  }
  if (rules.minLength !== undefined && candidate.length < rules.minLength) {
    issues.push(
      issue(
        fieldPath,
        "TOO_SHORT",
        `Must contain at least ${rules.minLength} characters.`,
      ),
    );
  }
  if (rules.maxLength !== undefined && candidate.length > rules.maxLength) {
    issues.push(
      issue(
        fieldPath,
        "TOO_LONG",
        `Must contain at most ${rules.maxLength} characters.`,
      ),
    );
  }
  if (rules.pattern !== undefined && !rules.pattern.test(candidate)) {
    issues.push(issue(fieldPath, "INVALID_FORMAT", "String has an invalid format."));
  }
  if (
    (rules.minLength !== undefined && candidate.length < rules.minLength) ||
    (rules.maxLength !== undefined && candidate.length > rules.maxLength)
  ) {
    return undefined;
  }
  return candidate;
}

export function readOptionalString(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
  rules: StringRules = {},
): string | null | undefined {
  if (!hasOwn(value, key) || value[key] === null) {
    return null;
  }
  return readString(value, key, path, issues, rules);
}

export interface NumberRules {
  readonly integer?: boolean;
  readonly safeInteger?: boolean;
  readonly min?: number;
  readonly max?: number;
}

export function readNumber(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
  rules: NumberRules = {},
): number | undefined {
  const fieldPath = joinPath(path, key);
  if (!hasOwn(value, key)) {
    issues.push(issue(fieldPath, "REQUIRED", "Field is required."));
    return undefined;
  }
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    issues.push(issue(fieldPath, "INVALID_TYPE", "Expected a finite number."));
    return undefined;
  }
  if (rules.integer && !Number.isInteger(candidate)) {
    issues.push(issue(fieldPath, "NOT_INTEGER", "Expected an integer."));
  }
  if (rules.safeInteger && !Number.isSafeInteger(candidate)) {
    issues.push(issue(fieldPath, "NOT_SAFE_INTEGER", "Expected a safe integer."));
  }
  if (rules.min !== undefined && candidate < rules.min) {
    issues.push(issue(fieldPath, "TOO_SMALL", `Must be at least ${rules.min}.`));
  }
  if (rules.max !== undefined && candidate > rules.max) {
    issues.push(issue(fieldPath, "TOO_LARGE", `Must be at most ${rules.max}.`));
  }
  return candidate;
}

export function readNullableNumber(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
  rules: NumberRules = {},
): number | null | undefined {
  if (!hasOwn(value, key)) {
    issues.push(issue(joinPath(path, key), "REQUIRED", "Field is required."));
    return undefined;
  }
  if (value[key] === null) {
    return null;
  }
  return readNumber(value, key, path, issues, rules);
}

export function readBoolean(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
): boolean | undefined {
  const fieldPath = joinPath(path, key);
  if (!hasOwn(value, key)) {
    issues.push(issue(fieldPath, "REQUIRED", "Field is required."));
    return undefined;
  }
  const candidate = value[key];
  if (typeof candidate !== "boolean") {
    issues.push(issue(fieldPath, "INVALID_TYPE", "Expected a boolean."));
    return undefined;
  }
  return candidate;
}

export function readEnum<T extends string>(
  value: UnknownRecord,
  key: string,
  allowedValues: readonly T[],
  path: string,
  issues: ValidationIssue[],
): T | undefined {
  const candidate = readString(value, key, path, issues);
  if (candidate === undefined) {
    return undefined;
  }
  if (!(allowedValues as readonly string[]).includes(candidate)) {
    issues.push(
      issue(
        joinPath(path, key),
        "INVALID_ENUM",
        `Expected one of: ${allowedValues.join(", ")}.`,
      ),
    );
    return undefined;
  }
  return candidate as T;
}

export function readUint8Array(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
  rules: { readonly minLength?: number; readonly maxLength?: number } = {},
): Uint8Array | undefined {
  const fieldPath = joinPath(path, key);
  if (!hasOwn(value, key)) {
    issues.push(issue(fieldPath, "REQUIRED", "Field is required."));
    return undefined;
  }
  const candidate = value[key];
  if (!(candidate instanceof Uint8Array)) {
    issues.push(
      issue(fieldPath, "INVALID_TYPE", "Expected binary data as Uint8Array."),
    );
    return undefined;
  }
  if (rules.minLength !== undefined && candidate.byteLength < rules.minLength) {
    issues.push(
      issue(
        fieldPath,
        "TOO_SHORT",
        `Must contain at least ${rules.minLength} bytes.`,
      ),
    );
  }
  if (rules.maxLength !== undefined && candidate.byteLength > rules.maxLength) {
    issues.push(
      issue(
        fieldPath,
        "TOO_LONG",
        `Must contain at most ${rules.maxLength} bytes.`,
      ),
    );
  }
  if (
    (rules.minLength !== undefined && candidate.byteLength < rules.minLength) ||
    (rules.maxLength !== undefined && candidate.byteLength > rules.maxLength)
  ) {
    return undefined;
  }
  return candidate;
}

export function readArray(
  value: UnknownRecord,
  key: string,
  path: string,
  issues: ValidationIssue[],
  rules: { readonly minLength?: number; readonly maxLength?: number } = {},
): readonly unknown[] | undefined {
  const fieldPath = joinPath(path, key);
  if (!hasOwn(value, key)) {
    issues.push(issue(fieldPath, "REQUIRED", "Field is required."));
    return undefined;
  }
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    issues.push(issue(fieldPath, "INVALID_TYPE", "Expected an array."));
    return undefined;
  }
  if (rules.minLength !== undefined && candidate.length < rules.minLength) {
    issues.push(
      issue(
        fieldPath,
        "TOO_SHORT",
        `Must contain at least ${rules.minLength} entries.`,
      ),
    );
  }
  if (rules.maxLength !== undefined && candidate.length > rules.maxLength) {
    issues.push(
      issue(
        fieldPath,
        "TOO_LONG",
        `Must contain at most ${rules.maxLength} entries.`,
      ),
    );
  }
  if (
    (rules.minLength !== undefined && candidate.length < rules.minLength) ||
    (rules.maxLength !== undefined && candidate.length > rules.maxLength)
  ) {
    return undefined;
  }
  return candidate;
}

export function appendResult<T>(
  result: ParseResult<T>,
  issues: ValidationIssue[],
  pathPrefix: string,
): T | undefined {
  if (result.ok) {
    return result.value;
  }
  for (const childIssue of result.issues) {
    issues.push({
      ...childIssue,
      path: prefixPath(pathPrefix, childIssue.path),
    });
  }
  return undefined;
}

export function joinPath(base: string, field: string | number): string {
  if (typeof field === "number") {
    return `${base}[${field}]`;
  }
  return base.length === 0 ? field : `${base}.${field}`;
}

function prefixPath(prefix: string, child: string): string {
  if (prefix.length === 0) {
    return child;
  }
  if (child.length === 0 || child === "$") {
    return prefix;
  }
  if (child.startsWith("[")) {
    return `${prefix}${child}`;
  }
  return `${prefix}.${child}`;
}

export function assertParsed<T>(
  result: ParseResult<T>,
  message = "Core value failed validation.",
): T {
  if (result.ok) {
    return result.value;
  }
  throw new CoreValidationError(message, result.issues);
}
