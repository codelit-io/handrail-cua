/** Defensive, classification-aware redaction for every persistent text surface. */

import type { Classification as DomainClassification } from "../domain/schema.js";

export type Classification = DomainClassification;

export type RedactedValue =
  | null
  | boolean
  | number
  | string
  | RedactedValue[]
  | { readonly [key: string]: RedactedValue };

export interface ClassifiedValue<T = unknown> {
  readonly classification: Classification;
  readonly value: T;
}

export interface RedactionOptions {
  /** Dot paths or JSON pointers mapped to their data-lineage classification. */
  readonly classifications?: Readonly<Record<string, Classification>>;
  readonly redactInternal?: boolean;
  readonly maxDepth?: number;
}

export interface SensitivePatternFinding {
  readonly kind: "secret" | "pii";
  readonly pattern: string;
  readonly count: number;
}

export const SECRET_REDACTION = "[REDACTED:SECRET]";
export const PII_REDACTION = "[REDACTED:PII]";
export const INTERNAL_REDACTION = "[REDACTED:INTERNAL]";

const VALID_CLASSIFICATIONS = new Set<Classification>(["public", "internal", "pii", "secret"]);
const CLASSIFICATION_RANK: Readonly<Record<Classification, number>> = {
  public: 0,
  internal: 1,
  pii: 2,
  secret: 3,
};

const SECRET_KEY =
  /(?:^|[_-])(?:api[_-]?key|auth(?:orization)?|bearer|cookie|credential|csrf|password|passwd|private[_-]?key|secret|storage[_-]?state|token)(?:$|[_-])/iu;
const PII_KEY =
  /(?:^|[_-])(?:account[_-]?(?:id|number)|address|card[_-]?number|customer[_-]?id|date[_-]?of[_-]?birth|dob|email|first[_-]?name|last[_-]?name|member[_-]?(?:id|number)|national[_-]?id|phone|routing[_-]?number|social[_-]?security|ssn|tax[_-]?id)(?:$|[_-])/iu;

interface PatternRule {
  readonly kind: "secret" | "pii";
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string | ((match: string, ...groups: string[]) => string);
}

const PATTERN_RULES: readonly PatternRule[] = [
  {
    kind: "secret",
    name: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
    replacement: SECRET_REDACTION,
  },
  {
    kind: "secret",
    name: "authorization-header",
    pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
    replacement: SECRET_REDACTION,
  },
  {
    kind: "secret",
    name: "provider-key",
    pattern:
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b/gu,
    replacement: SECRET_REDACTION,
  },
  {
    kind: "secret",
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    replacement: SECRET_REDACTION,
  },
  {
    kind: "secret",
    name: "url-credentials",
    pattern: /\b[A-Z][A-Z0-9+.-]{1,15}:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+(?:\/[^\s]*)?/giu,
    replacement: SECRET_REDACTION,
  },
  {
    kind: "secret",
    name: "secret-assignment",
    pattern:
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|password|passwd|secret)\s*([:=])\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n,;}\]]+)/giu,
    replacement: (_match, label, operator) => `${label}${operator}${SECRET_REDACTION}`,
  },
  {
    kind: "secret",
    name: "secret-query-parameter",
    pattern:
      /([?&](?:api[_-]?key|access[_-]?token|auth|code|credential|password|secret|token)=)[^&#\s]+/giu,
    replacement: (_match, prefix) => `${prefix}${SECRET_REDACTION}`,
  },
  {
    kind: "pii",
    name: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    replacement: PII_REDACTION,
  },
  {
    kind: "pii",
    name: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/gu,
    replacement: PII_REDACTION,
  },
  {
    kind: "pii",
    name: "phone",
    pattern: /(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/gu,
    replacement: PII_REDACTION,
  },
];

export function classified<T>(value: T, classification: Classification): ClassifiedValue<T> {
  return { classification, value };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isClassifiedValue(value: unknown): value is ClassifiedValue {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("classification") || !keys.includes("value")) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "classification");
  return (
    Object.hasOwn(value, "value") &&
    descriptor !== undefined &&
    "value" in descriptor &&
    typeof descriptor.value === "string" &&
    VALID_CLASSIFICATIONS.has(descriptor.value as Classification)
  );
}

function hasClassifiedShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes("classification") && keys.includes("value");
}

function strongestClassification(
  ...classifications: readonly (Classification | undefined)[]
): Classification | undefined {
  let strongest: Classification | undefined;
  for (const classification of classifications) {
    if (
      classification &&
      (strongest === undefined ||
        CLASSIFICATION_RANK[classification] > CLASSIFICATION_RANK[strongest])
    ) {
      strongest = classification;
    }
  }
  return strongest;
}

function markerFor(classification: Classification, redactInternal: boolean): string | undefined {
  if (classification === "secret") {
    return SECRET_REDACTION;
  }
  if (classification === "pii") {
    return PII_REDACTION;
  }
  if (classification === "internal" && redactInternal) {
    return INTERNAL_REDACTION;
  }
  return undefined;
}

function classificationForKey(key: string): Classification | undefined {
  const normalized = key.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (SECRET_KEY.test(normalized)) {
    return "secret";
  }
  if (PII_KEY.test(normalized)) {
    return "pii";
  }
  return undefined;
}

function escapeJsonPointer(part: string): string {
  return part.replaceAll("~", "~0").replaceAll("/", "~1");
}

function configuredClassification(
  classifications: Readonly<Record<string, Classification>> | undefined,
  dotPath: string,
  pointerPath: string,
): Classification | undefined {
  if (!classifications) {
    return undefined;
  }
  return classifications[dotPath] ?? classifications[pointerPath];
}

/** Redact known secret and PII shapes in otherwise unclassified text. */
export function redactText(input: string): string {
  let redacted = input;
  for (const rule of PATTERN_RULES) {
    redacted =
      typeof rule.replacement === "string"
        ? redacted.replace(rule.pattern, rule.replacement)
        : redacted.replace(rule.pattern, rule.replacement);
  }
  return redacted;
}

/**
 * Report pattern classes and counts without returning the matched values.
 * This is useful for release checks without reflecting a secret into CI output.
 */
export function findSensitivePatterns(input: string): SensitivePatternFinding[] {
  const findings: SensitivePatternFinding[] = [];
  for (const rule of PATTERN_RULES) {
    const matches = input.match(rule.pattern);
    if (matches && matches.length > 0) {
      findings.push({ kind: rule.kind, pattern: rule.name, count: matches.length });
    }
  }
  return findings;
}

interface RedactionState {
  readonly options: Required<Pick<RedactionOptions, "maxDepth" | "redactInternal">> &
    Pick<RedactionOptions, "classifications">;
  readonly seen: WeakSet<object>;
}

function redactRecursive(
  input: unknown,
  state: RedactionState,
  depth: number,
  dotPath: string,
  pointerPath: string,
  inheritedClassification?: Classification,
): RedactedValue {
  if (depth > state.options.maxDepth) {
    return "[TRUNCATED:MAX_DEPTH]";
  }

  let value = input;
  let classification = strongestClassification(
    configuredClassification(state.options.classifications, dotPath, pointerPath),
    inheritedClassification,
  );

  if (isClassifiedValue(value)) {
    const wrappedClassification =
      strongestClassification(classification, value.classification) ?? value.classification;
    classification = wrappedClassification;
    const marker = markerFor(wrappedClassification, state.options.redactInternal);
    if (marker) {
      return marker;
    }
    value = value.value;
  } else if (hasClassifiedShape(value)) {
    // A malformed/unknown classification must not silently declassify its value.
    return SECRET_REDACTION;
  }

  const marker = classification
    ? markerFor(classification, state.options.redactInternal)
    : undefined;
  if (marker) {
    return marker;
  }

  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "[UNDEFINED]";
  }
  if (typeof value === "function") {
    return "[FUNCTION]";
  }
  if (typeof value === "symbol") {
    return "[SYMBOL]";
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[INVALID_DATE]" : value.toISOString();
  }
  if (value instanceof URL) {
    return redactText(value.href);
  }
  if (value instanceof Error) {
    return {
      name: redactText(value.name),
      message: redactText(value.message),
    };
  }
  if (ArrayBuffer.isView(value)) {
    return `[BINARY:${value.byteLength} bytes]`;
  }
  if (value instanceof ArrayBuffer) {
    return `[BINARY:${value.byteLength} bytes]`;
  }

  if (state.seen.has(value)) {
    return "[CIRCULAR]";
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const nextDotPath = dotPath ? `${dotPath}.${index}` : String(index);
      const nextPointerPath = `${pointerPath}/${index}`;
      return redactRecursive(entry, state, depth + 1, nextDotPath, nextPointerPath, classification);
    });
  }

  const output: Record<string, RedactedValue> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    const nextDotPath = dotPath ? `${dotPath}.${key}` : key;
    const nextPointerPath = `${pointerPath}/${escapeJsonPointer(key)}`;
    const configured = configuredClassification(
      state.options.classifications,
      nextDotPath,
      nextPointerPath,
    );
    const keyClassification =
      configured === undefined
        ? strongestClassification(classificationForKey(key), classification)
        : strongestClassification(configured, classification);

    const safeKey = redactText(key);
    if (!("value" in descriptor)) {
      output[safeKey] = "[ACCESSOR]";
      continue;
    }

    output[safeKey] = redactRecursive(
      descriptor.value,
      state,
      depth + 1,
      nextDotPath,
      nextPointerPath,
      keyClassification,
    );
  }
  return output;
}

/**
 * Recursively copy a value into a JSON-safe structure while redacting by both
 * explicit data lineage and defensive key/content patterns.
 */
export function redactValue(input: unknown, options: RedactionOptions = {}): RedactedValue {
  const maxDepth = options.maxDepth ?? 32;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 256) {
    throw new RangeError("maxDepth must be a safe integer between 0 and 256");
  }
  if (
    options.classifications &&
    Object.values(options.classifications).some(
      (classification) => !VALID_CLASSIFICATIONS.has(classification),
    )
  ) {
    throw new TypeError("classifications contains an unknown classification");
  }

  const state: RedactionState = {
    options: {
      maxDepth,
      redactInternal: options.redactInternal ?? false,
      ...(options.classifications ? { classifications: options.classifications } : {}),
    },
    seen: new WeakSet<object>(),
  };
  return redactRecursive(input, state, 0, "", "", undefined);
}

/** JSON serialization with redaction applied before bytes are created. */
export function stringifyRedacted(input: unknown, options?: RedactionOptions): string {
  return JSON.stringify(redactValue(input, options));
}
