import { createHash } from "node:crypto";

import {
  type AtomicPredicate,
  type CapabilityArtifact,
  type CapabilityArtifactDraft,
  CapabilityArtifactDraftSchema,
  CapabilityArtifactSchema,
  type InputSpec,
  type OutputSpec,
  type Predicate,
  type ScalarValue,
  ScalarValueSchema,
  type Step,
  type TargetCandidate,
  type ValueExpression,
} from "../domain/schema.js";

export type ArtifactLintCode =
  | "SCHEMA_INVALID"
  | "SENSITIVE_LITERAL"
  | "MISSING_POSTCONDITION"
  | "UNSAFE_RETRY"
  | "WEAK_TARGET"
  | "DUPLICATE_CANDIDATE"
  | "DUPLICATE_STEP_ID"
  | "UNKNOWN_TARGET"
  | "UNKNOWN_INPUT"
  | "UNKNOWN_OUTPUT"
  | "UNKNOWN_STEP_OUTPUT"
  | "COMMAND_NOT_ALLOWED"
  | "EFFECT_NOT_ALLOWED"
  | "UNDECLARED_EFFECT"
  | "APPROVAL_REQUIRED"
  | "ROUTE_NOT_ALLOWED"
  | "MISSING_TERMINAL_SUCCESS"
  | "WEAK_TERMINAL_SUCCESS"
  | "OUTPUT_NOT_EXTRACTED"
  | "INVALID_REGEX"
  | "DIGEST_MISMATCH";

export interface ArtifactLintIssue {
  readonly code: ArtifactLintCode;
  readonly path: string;
  readonly message: string;
  readonly severity: "error";
}

export interface ArtifactLintResult {
  readonly ok: boolean;
  readonly issues: readonly ArtifactLintIssue[];
}

export interface ValueBindingContext {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly stepOutputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly resolveSecret?: (name: string) => ScalarValue;
}

export type ArtifactBindingErrorCode =
  | "INPUT_MISSING"
  | "INPUT_INVALID"
  | "OUTPUT_MISSING"
  | "OUTPUT_INVALID"
  | "STEP_OUTPUT_MISSING"
  | "SECRET_BROKER_MISSING"
  | "SECRET_MISSING";

export class ArtifactBindingError extends Error {
  readonly code: ArtifactBindingErrorCode;
  readonly path: string;

  constructor(code: ArtifactBindingErrorCode, path: string, message: string) {
    super(message);
    this.name = "ArtifactBindingError";
    this.code = code;
    this.path = path;
  }
}

export class ArtifactCompilationError extends Error {
  readonly issues: readonly ArtifactLintIssue[];

  constructor(issues: readonly ArtifactLintIssue[]) {
    super(
      `Capability artifact rejected with ${issues.length} lint error${issues.length === 1 ? "" : "s"}.`,
    );
    this.name = "ArtifactCompilationError";
    this.issues = issues;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Canonical JSON rejects a non-finite number at ${path}.`);
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }

  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON rejects ${typeof value} at ${path}.`);
  }

  if (seen.has(value)) {
    throw new TypeError(`Canonical JSON rejects a circular reference at ${path}.`);
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => canonicalize(item, seen, `${path}[${index}]`)).join(",")}]`;
    }

    if (!isPlainRecord(value)) {
      throw new TypeError(`Canonical JSON accepts only plain objects at ${path}.`);
    }

    const members = Object.keys(value)
      .sort()
      .map((key) => {
        const member = value[key];
        if (member === undefined) {
          throw new TypeError(`Canonical JSON rejects undefined at ${path}.${key}.`);
        }
        return `${JSON.stringify(key)}:${canonicalize(member, seen, `${path}.${key}`)}`;
      });
    return `{${members.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Stable JSON serialization: object keys are sorted and arrays retain semantic order. */
export function canonicalStringify(value: unknown): string {
  return canonicalize(value, new Set<object>(), "$");
}

function withoutDigest(value: unknown): unknown {
  if (!isPlainRecord(value) || !("digest" in value)) {
    return value;
  }
  const copy: Record<string, unknown> = { ...value };
  delete copy.digest;
  return copy;
}

/** Digest only reviewed content; the digest field itself is deliberately excluded. */
export function computeArtifactDigest(
  artifact: CapabilityArtifact | CapabilityArtifactDraft,
): string {
  return createHash("sha256")
    .update(canonicalStringify(withoutDigest(artifact)))
    .digest("hex");
}

export function verifyArtifactDigest(input: unknown): input is CapabilityArtifact {
  const parsed = CapabilityArtifactSchema.safeParse(input);
  return parsed.success && parsed.data.digest === computeArtifactDigest(parsed.data);
}

function issue(code: ArtifactLintCode, path: string, message: string): ArtifactLintIssue {
  return { code, path, message, severity: "error" };
}

function formatPath(path: readonly PropertyKey[]): string {
  let result = "$";
  for (const part of path) {
    result += typeof part === "number" ? `[${part}]` : `.${String(part)}`;
  }
  return result;
}

function schemaIssueCode(path: string): ArtifactLintCode {
  if (path === "$.success" || path.startsWith("$.success.")) {
    return "MISSING_TERMINAL_SUCCESS";
  }
  if (/^\$\.steps\[\d+\]\.postcondition(?:\.|$)/u.test(path)) {
    return "MISSING_POSTCONDITION";
  }
  if (/^\$\.targets(?:\.|$)/u.test(path)) {
    return "WEAK_TARGET";
  }
  return "SCHEMA_INVALID";
}

function schemaIssues(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): ArtifactLintIssue[] {
  return error.issues.map((entry) => {
    const path = formatPath(entry.path);
    return issue(schemaIssueCode(path), path, entry.message);
  });
}

function predicateAtoms(predicate: Predicate): readonly AtomicPredicate[] {
  switch (predicate.kind) {
    case "all":
    case "any":
      return predicate.predicates;
    case "not":
      return [predicate.predicate];
    default:
      return [predicate];
  }
}

function expressionFromPredicate(predicate: AtomicPredicate): ValueExpression | undefined {
  return predicate.kind === "target_value_equals" ? predicate.expected : undefined;
}

function targetFromPredicate(predicate: AtomicPredicate): string | undefined {
  switch (predicate.kind) {
    case "target_visible":
    case "target_text_matches":
    case "target_value_equals":
      return predicate.target;
    default:
      return undefined;
  }
}

function candidateAnchor(candidate: TargetCandidate): string {
  switch (candidate.kind) {
    case "role":
      return `${candidate.role}:${candidate.name}`;
    case "label":
      return candidate.label;
    case "table":
      return `${candidate.rowLabel}:${candidate.columnLabel}`;
    case "relation":
      return `${candidate.anchorText}:${candidate.relationship}`;
    case "attribute":
      return `${candidate.attribute}:${candidate.value}`;
    case "visual":
      return candidate.anchorText;
  }
}

const WEAK_ANCHORS = new Set([
  "*",
  "button",
  "cell",
  "click",
  "click here",
  "control",
  "input",
  "item",
  "link",
  "row",
  "text",
]);

function candidateIsWeak(candidate: TargetCandidate): boolean {
  const anchor = candidateAnchor(candidate).trim().toLowerCase();
  if (anchor.length < 3 || WEAK_ANCHORS.has(anchor)) {
    return true;
  }
  if (candidate.kind === "role") {
    return candidate.name.trim().toLowerCase() === candidate.role;
  }
  if (candidate.kind === "attribute") {
    return /(?:^|[-_.])(session|timestamp|random|generated|nonce)(?:[-_.]|$)/iu.test(
      candidate.attribute,
    );
  }
  return false;
}

function containsPaymentCard(value: string): boolean {
  const digits = value.replace(/[ -]/gu, "");
  if (!/^\d{13,19}$/u.test(digits)) {
    return false;
  }
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const character = digits[index];
    if (character === undefined) {
      return false;
    }
    let digit = Number(character);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function looksSensitiveString(value: string): boolean {
  return (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/iu.test(value) ||
    /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/u.test(value) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value) ||
    /\b\d{3}-\d{2}-\d{4}\b/u.test(value) ||
    containsPaymentCard(value)
  );
}

function lintSensitiveStrings(value: unknown, path: string, issues: ArtifactLintIssue[]): void {
  if (typeof value === "string") {
    if (looksSensitiveString(value)) {
      issues.push(
        issue(
          "SENSITIVE_LITERAL",
          path,
          "Sensitive-looking content must be replaced by a typed runtime reference.",
        ),
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, member] of value.entries()) {
      lintSensitiveStrings(member, `${path}[${index}]`, issues);
    }
    return;
  }
  if (isPlainRecord(value)) {
    for (const [key, member] of Object.entries(value)) {
      lintSensitiveStrings(member, `${path}.${key}`, issues);
    }
  }
}

function lintExpression(
  expression: ValueExpression,
  path: string,
  artifact: CapabilityArtifactDraft,
  stepIndexById: ReadonlyMap<string, number>,
  currentStepIndex: number | undefined,
  issues: ArtifactLintIssue[],
): void {
  switch (expression.kind) {
    case "input":
      if (!(expression.name in artifact.contract.inputs)) {
        issues.push(
          issue(
            "UNKNOWN_INPUT",
            `${path}.name`,
            `Input ${expression.name} is not declared by the contract.`,
          ),
        );
      }
      break;
    case "step_output": {
      const sourceIndex = stepIndexById.get(expression.stepId);
      const sourceStep = sourceIndex === undefined ? undefined : artifact.steps[sourceIndex];
      if (
        sourceIndex === undefined ||
        sourceStep?.command !== "extract" ||
        sourceStep.output !== expression.name ||
        (currentStepIndex !== undefined && sourceIndex >= currentStepIndex)
      ) {
        issues.push(
          issue(
            "UNKNOWN_STEP_OUTPUT",
            path,
            `Step output ${expression.stepId}.${expression.name} is absent or not available yet.`,
          ),
        );
      }
      break;
    }
    case "secret_ref":
      break;
    case "literal":
      if (
        expression.classification === "pii" ||
        expression.classification === "secret" ||
        (typeof expression.value === "string" && looksSensitiveString(expression.value))
      ) {
        issues.push(
          issue(
            "SENSITIVE_LITERAL",
            `${path}.value`,
            "Sensitive or sensitive-looking values must be runtime references, never artifact literals.",
          ),
        );
      }
      break;
  }
}

function lintPredicate(
  predicate: Predicate,
  path: string,
  artifact: CapabilityArtifactDraft,
  stepIndexById: ReadonlyMap<string, number>,
  currentStepIndex: number | undefined,
  issues: ArtifactLintIssue[],
): void {
  for (const [index, atom] of predicateAtoms(predicate).entries()) {
    const atomPath =
      predicate.kind === "all" || predicate.kind === "any"
        ? `${path}.predicates[${index}]`
        : predicate.kind === "not"
          ? `${path}.predicate`
          : path;
    const target = targetFromPredicate(atom);
    if (target !== undefined && !(target in artifact.targets)) {
      issues.push(
        issue("UNKNOWN_TARGET", `${atomPath}.target`, `Target ${target} is not declared.`),
      );
    }
    if (atom.kind === "output_valid" && !(atom.output in artifact.contract.outputs)) {
      issues.push(
        issue("UNKNOWN_OUTPUT", `${atomPath}.output`, `Output ${atom.output} is not declared.`),
      );
    }
    const expression = expressionFromPredicate(atom);
    if (expression !== undefined) {
      lintExpression(
        expression,
        `${atomPath}.expected`,
        artifact,
        stepIndexById,
        currentStepIndex,
        issues,
      );
    }
    if (atom.kind === "target_text_matches" && atom.matcher.mode === "regex") {
      try {
        new RegExp(atom.matcher.value, atom.matcher.caseSensitive ? "u" : "iu");
      } catch {
        issues.push(
          issue(
            "INVALID_REGEX",
            `${atomPath}.matcher.value`,
            "Text matcher is not a valid regular expression.",
          ),
        );
      }
    }
  }
}

function targetForStep(step: Step): string | undefined {
  switch (step.command) {
    case "set_value":
    case "activate":
    case "press_key":
      return step.target;
    case "extract":
      return step.extractor.target;
    default:
      return undefined;
  }
}

function lintTargets(artifact: CapabilityArtifactDraft, issues: ArtifactLintIssue[]): void {
  if (Object.keys(artifact.targets).length === 0) {
    issues.push(
      issue("WEAK_TARGET", "$.targets", "A capability must declare durable logical targets."),
    );
  }
  for (const [targetName, target] of Object.entries(artifact.targets)) {
    const path = `$.targets.${targetName}`;
    if (target.candidates.length < 2) {
      issues.push(
        issue(
          "WEAK_TARGET",
          `${path}.candidates`,
          "A durable target needs at least two ordered resolution candidates.",
        ),
      );
    }

    const candidateKeys = new Set<string>();
    for (const [index, candidate] of target.candidates.entries()) {
      const candidatePath = `${path}.candidates[${index}]`;
      if (candidateIsWeak(candidate)) {
        issues.push(
          issue(
            "WEAK_TARGET",
            candidatePath,
            "Target candidate is too broad or relies on an unstable anchor.",
          ),
        );
      }
      const key = canonicalStringify(candidate);
      if (candidateKeys.has(key)) {
        issues.push(
          issue(
            "DUPLICATE_CANDIDATE",
            candidatePath,
            "Duplicate candidates add no fallback robustness.",
          ),
        );
      }
      candidateKeys.add(key);
      if (candidate.kind === "visual" && index !== target.candidates.length - 1) {
        issues.push(
          issue(
            "WEAK_TARGET",
            candidatePath,
            "A visual target must be the final fallback candidate.",
          ),
        );
      }
    }

    if (
      target.candidates.some((candidate) => candidate.kind === "visual") &&
      !artifact.compatibility.requiredSurfaceCapabilities.includes("visual_anchors")
    ) {
      issues.push(
        issue(
          "WEAK_TARGET",
          `${path}.candidates`,
          "A visual candidate requires the visual_anchors surface capability.",
        ),
      );
    }
  }
}

function lintTerminalSuccess(
  artifact: CapabilityArtifactDraft,
  stepIndexById: ReadonlyMap<string, number>,
  issues: ArtifactLintIssue[],
): void {
  const atoms = predicateAtoms(artifact.success);
  const surfaceCheckCount = atoms.filter(
    (atom) =>
      atom.kind === "target_visible" ||
      atom.kind === "target_text_matches" ||
      atom.kind === "target_value_equals" ||
      atom.kind === "surface_fingerprint",
  ).length;
  const validatedOutputs = new Set(
    atoms.filter((atom) => atom.kind === "output_valid").map((atom) => atom.output),
  );

  if (artifact.success.kind !== "all" || surfaceCheckCount === 0) {
    issues.push(
      issue(
        "WEAK_TERMINAL_SUCCESS",
        "$.success",
        "Terminal success must combine an independent surface checkpoint with declared output validation.",
      ),
    );
  }

  for (const output of Object.keys(artifact.contract.outputs)) {
    if (!validatedOutputs.has(output)) {
      issues.push(
        issue(
          "WEAK_TERMINAL_SUCCESS",
          "$.success",
          `Terminal success does not validate declared output ${output}.`,
        ),
      );
    }
  }

  lintPredicate(artifact.success, "$.success", artifact, stepIndexById, undefined, issues);
}

function lintParsedArtifact(artifact: CapabilityArtifactDraft): ArtifactLintIssue[] {
  const issues: ArtifactLintIssue[] = [];
  lintSensitiveStrings(artifact, "$", issues);
  lintTargets(artifact, issues);

  const stepIndexById = new Map<string, number>();
  for (const [index, step] of artifact.steps.entries()) {
    if (stepIndexById.has(step.id)) {
      issues.push(
        issue("DUPLICATE_STEP_ID", `$.steps[${index}].id`, `Step id ${step.id} is duplicated.`),
      );
    } else {
      stepIndexById.set(step.id, index);
    }
  }

  const extractedOutputs = new Set<string>();
  for (const [index, step] of artifact.steps.entries()) {
    const path = `$.steps[${index}]`;
    const target = targetForStep(step);
    if (target !== undefined && !(target in artifact.targets)) {
      issues.push(issue("UNKNOWN_TARGET", `${path}.target`, `Target ${target} is not declared.`));
    }

    if (!artifact.policyRequirements.allowedCommands.includes(step.command)) {
      issues.push(
        issue(
          "COMMAND_NOT_ALLOWED",
          `${path}.command`,
          `Command ${step.command} is outside capability policy.`,
        ),
      );
    }
    if (!artifact.policyRequirements.allowedEffects.includes(step.effect)) {
      issues.push(
        issue(
          "EFFECT_NOT_ALLOWED",
          `${path}.effect`,
          `Effect ${step.effect} is outside capability policy.`,
        ),
      );
    }
    if (!artifact.effects.includes(step.effect)) {
      issues.push(
        issue(
          "UNDECLARED_EFFECT",
          `${path}.effect`,
          `Effect ${step.effect} is absent from artifact effects.`,
        ),
      );
    }

    if (
      step.retry.maxAttempts > 1 &&
      (step.idempotency === "non_idempotent" || step.effect === "commit")
    ) {
      issues.push(
        issue(
          "UNSAFE_RETRY",
          `${path}.retry.maxAttempts`,
          "Commit and non-idempotent actions cannot be retried automatically.",
        ),
      );
    }

    if (
      (step.command === "wait_for" ||
        step.command === "extract" ||
        step.command === "capture_evidence" ||
        step.command === "navigate") &&
      (step.effect !== "read" || step.idempotency !== "idempotent")
    ) {
      issues.push(
        issue("UNDECLARED_EFFECT", path, `${step.command} must be a read, idempotent step.`),
      );
    }

    if (step.command === "set_value") {
      if (step.value.kind === "literal") {
        issues.push(
          issue(
            "SENSITIVE_LITERAL",
            `${path}.value`,
            "Set-value steps must bind an input or secret reference, not persist an invocation literal.",
          ),
        );
      }
      lintExpression(step.value, `${path}.value`, artifact, stepIndexById, index, issues);
    }

    if (step.command === "extract") {
      if (!(step.output in artifact.contract.outputs)) {
        issues.push(
          issue(
            "UNKNOWN_OUTPUT",
            `${path}.output`,
            `Output ${step.output} is not declared by the contract.`,
          ),
        );
      }
      extractedOutputs.add(step.output);
    }

    if (step.command === "wait_for") {
      lintPredicate(step.condition, `${path}.condition`, artifact, stepIndexById, index, issues);
    }
    lintPredicate(
      step.postcondition,
      `${path}.postcondition`,
      artifact,
      stepIndexById,
      index,
      issues,
    );
  }

  for (const [index, outcome] of artifact.contract.outcomes.entries()) {
    lintPredicate(
      outcome.when,
      `$.contract.outcomes[${index}].when`,
      artifact,
      stepIndexById,
      undefined,
      issues,
    );
  }

  for (const output of Object.keys(artifact.contract.outputs)) {
    if (!extractedOutputs.has(output)) {
      issues.push(
        issue(
          "OUTPUT_NOT_EXTRACTED",
          `$.contract.outputs.${output}`,
          `Declared output ${output} has no extraction step.`,
        ),
      );
    }
  }

  if (
    artifact.effects.includes("commit") &&
    !artifact.policyRequirements.approvalRequiredFor.includes("commit")
  ) {
    issues.push(
      issue(
        "APPROVAL_REQUIRED",
        "$.policyRequirements.approvalRequiredFor",
        "Capabilities with commit effects must require bound approval.",
      ),
    );
  }

  if (
    artifact.entrypoint.route !== undefined &&
    !artifact.policyRequirements.allowedRoutes.includes(artifact.entrypoint.route)
  ) {
    issues.push(
      issue(
        "ROUTE_NOT_ALLOWED",
        "$.entrypoint.route",
        "The entrypoint route must be included in capability policy.",
      ),
    );
  }
  for (const [index, step] of artifact.steps.entries()) {
    if (
      step.command === "navigate" &&
      !artifact.policyRequirements.allowedRoutes.includes(step.route)
    ) {
      issues.push(
        issue(
          "ROUTE_NOT_ALLOWED",
          `$.steps[${index}].route`,
          `Navigation route ${step.route} is outside capability policy.`,
        ),
      );
    }
  }

  lintTerminalSuccess(artifact, stepIndexById, issues);
  return issues;
}

/** Validate both the runtime schema and the cross-field safety invariants. */
export function lintArtifact(input: unknown): ArtifactLintResult {
  const hasDigest = isPlainRecord(input) && "digest" in input;
  const parsed = hasDigest
    ? CapabilityArtifactSchema.safeParse(input)
    : CapabilityArtifactDraftSchema.safeParse(input);
  if (!parsed.success) {
    const issues = schemaIssues(parsed.error);
    return { ok: false, issues };
  }

  const draft = CapabilityArtifactDraftSchema.parse(withoutDigest(parsed.data));
  const issues = lintParsedArtifact(draft);
  if (hasDigest) {
    const artifact = CapabilityArtifactSchema.parse(parsed.data);
    if (artifact.digest !== computeArtifactDigest(artifact)) {
      issues.push(
        issue(
          "DIGEST_MISMATCH",
          "$.digest",
          "Artifact digest does not match its canonical reviewed content.",
        ),
      );
    }
  }
  return { ok: issues.length === 0, issues };
}

function deepFreeze<T>(value: T, seen: WeakSet<object>): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const member of Object.values(value)) {
    deepFreeze(member, seen);
  }
  return Object.freeze(value);
}

/** Compile a draft into immutable, digest-bound content or throw with reviewable lint issues. */
export function compileArtifact(input: unknown): CapabilityArtifact {
  const parsed = CapabilityArtifactDraftSchema.safeParse(withoutDigest(input));
  if (!parsed.success) {
    throw new ArtifactCompilationError(schemaIssues(parsed.error));
  }
  const issues = lintParsedArtifact(parsed.data);
  if (issues.length > 0) {
    throw new ArtifactCompilationError(issues);
  }
  const artifact = CapabilityArtifactSchema.parse({
    ...parsed.data,
    digest: computeArtifactDigest(parsed.data),
  });
  return deepFreeze(artifact, new WeakSet<object>());
}

/** Parse an approved artifact and fail closed on schema, lint, or digest drift. */
export function assertValidArtifact(input: unknown): CapabilityArtifact {
  const result = lintArtifact(input);
  if (!result.ok) {
    throw new ArtifactCompilationError(result.issues);
  }
  return deepFreeze(CapabilityArtifactSchema.parse(input), new WeakSet<object>());
}

function validateWithSpec(
  value: ScalarValue,
  spec: InputSpec | OutputSpec,
  path: string,
  errorCode: "INPUT_INVALID" | "OUTPUT_INVALID",
): void {
  const validator = spec.validator;
  if (validator.kind === "string") {
    if (typeof value !== "string") {
      throw new ArtifactBindingError(errorCode, path, "Expected a string value.");
    }
    if (validator.minLength !== undefined && value.length < validator.minLength) {
      throw new ArtifactBindingError(errorCode, path, "String value is shorter than allowed.");
    }
    if (validator.maxLength !== undefined && value.length > validator.maxLength) {
      throw new ArtifactBindingError(errorCode, path, "String value is longer than allowed.");
    }
    if (validator.enum !== undefined && !validator.enum.includes(value)) {
      throw new ArtifactBindingError(
        errorCode,
        path,
        "String value is outside the allowed values.",
      );
    }
    if (validator.pattern !== undefined) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(validator.pattern, "u");
      } catch {
        throw new ArtifactBindingError(
          errorCode,
          path,
          "Contract validator contains an invalid pattern.",
        );
      }
      if (!pattern.test(value)) {
        throw new ArtifactBindingError(
          errorCode,
          path,
          "String value does not match the contract.",
        );
      }
    }
    return;
  }

  if (validator.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ArtifactBindingError(errorCode, path, "Expected a finite number value.");
    }
    if (validator.minimum !== undefined && value < validator.minimum) {
      throw new ArtifactBindingError(errorCode, path, "Number value is below the allowed minimum.");
    }
    if (validator.maximum !== undefined && value > validator.maximum) {
      throw new ArtifactBindingError(errorCode, path, "Number value is above the allowed maximum.");
    }
    if (validator.integer === true && !Number.isInteger(value)) {
      throw new ArtifactBindingError(errorCode, path, "Expected an integer value.");
    }
    return;
  }

  if (typeof value !== "boolean") {
    throw new ArtifactBindingError(errorCode, path, "Expected a boolean value.");
  }
}

/** Validate invocation data before opening or mutating a surface. */
export function bindArtifactInputs(
  artifact: CapabilityArtifact,
  rawInputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, ScalarValue>> {
  const unknownNames = Object.keys(rawInputs).filter((name) => !(name in artifact.contract.inputs));
  if (unknownNames.length > 0) {
    throw new ArtifactBindingError(
      "INPUT_INVALID",
      `$.inputs.${unknownNames[0]}`,
      `Input ${unknownNames[0]} is not declared by the capability.`,
    );
  }

  const bound: Record<string, ScalarValue> = {};
  for (const [name, spec] of Object.entries(artifact.contract.inputs)) {
    const raw = rawInputs[name];
    if (raw === undefined) {
      if (spec.required) {
        throw new ArtifactBindingError(
          "INPUT_MISSING",
          `$.inputs.${name}`,
          `Required input ${name} is missing.`,
        );
      }
      continue;
    }
    const scalar = ScalarValueSchema.safeParse(raw);
    if (!scalar.success) {
      throw new ArtifactBindingError(
        "INPUT_INVALID",
        `$.inputs.${name}`,
        `Input ${name} must be a scalar value.`,
      );
    }
    validateWithSpec(scalar.data, spec, `$.inputs.${name}`, "INPUT_INVALID");
    bound[name] = scalar.data;
  }
  return Object.freeze(bound);
}

/** Validate that replay extracted every declared output with no undeclared values. */
export function validateArtifactOutputs(
  artifact: CapabilityArtifact,
  rawOutputs: Readonly<Record<string, unknown>>,
): Readonly<Record<string, ScalarValue>> {
  const unknownNames = Object.keys(rawOutputs).filter(
    (name) => !(name in artifact.contract.outputs),
  );
  if (unknownNames.length > 0) {
    throw new ArtifactBindingError(
      "OUTPUT_INVALID",
      `$.outputs.${unknownNames[0]}`,
      `Output ${unknownNames[0]} is not declared by the capability.`,
    );
  }

  const validated: Record<string, ScalarValue> = {};
  for (const [name, spec] of Object.entries(artifact.contract.outputs)) {
    const raw = rawOutputs[name];
    if (raw === undefined) {
      throw new ArtifactBindingError(
        "OUTPUT_MISSING",
        `$.outputs.${name}`,
        `Declared output ${name} was not extracted.`,
      );
    }
    const scalar = ScalarValueSchema.safeParse(raw);
    if (!scalar.success) {
      throw new ArtifactBindingError(
        "OUTPUT_INVALID",
        `$.outputs.${name}`,
        `Output ${name} must be a scalar value.`,
      );
    }
    validateWithSpec(scalar.data, spec, `$.outputs.${name}`, "OUTPUT_INVALID");
    validated[name] = scalar.data;
  }
  return Object.freeze(validated);
}

/** Resolve a typed value node without string interpolation or implicit coercion. */
export function bindValueExpression(
  expression: ValueExpression,
  context: ValueBindingContext,
): ScalarValue {
  switch (expression.kind) {
    case "input": {
      const value = context.inputs[expression.name];
      if (value === undefined) {
        throw new ArtifactBindingError(
          "INPUT_MISSING",
          `$.inputs.${expression.name}`,
          `Input ${expression.name} is not bound.`,
        );
      }
      const parsed = ScalarValueSchema.safeParse(value);
      if (!parsed.success) {
        throw new ArtifactBindingError(
          "INPUT_INVALID",
          `$.inputs.${expression.name}`,
          `Input ${expression.name} is not a scalar value.`,
        );
      }
      return parsed.data;
    }
    case "step_output": {
      const value = context.stepOutputs?.[expression.stepId]?.[expression.name];
      if (value === undefined) {
        throw new ArtifactBindingError(
          "STEP_OUTPUT_MISSING",
          `$.stepOutputs.${expression.stepId}.${expression.name}`,
          `Step output ${expression.stepId}.${expression.name} is unavailable.`,
        );
      }
      const parsed = ScalarValueSchema.safeParse(value);
      if (!parsed.success) {
        throw new ArtifactBindingError(
          "STEP_OUTPUT_MISSING",
          `$.stepOutputs.${expression.stepId}.${expression.name}`,
          "Step output is not a scalar value.",
        );
      }
      return parsed.data;
    }
    case "secret_ref":
      if (context.resolveSecret === undefined) {
        throw new ArtifactBindingError(
          "SECRET_BROKER_MISSING",
          `$.secrets.${expression.name}`,
          "A runtime secret broker is required for this value.",
        );
      }
      try {
        return ScalarValueSchema.parse(context.resolveSecret(expression.name));
      } catch (error: unknown) {
        if (error instanceof ArtifactBindingError) {
          throw error;
        }
        throw new ArtifactBindingError(
          "SECRET_MISSING",
          `$.secrets.${expression.name}`,
          `Secret reference ${expression.name} could not be resolved.`,
        );
      }
    case "literal":
      return expression.value;
  }
}
