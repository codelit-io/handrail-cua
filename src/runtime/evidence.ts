import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import type { AutomationEvent, EvidenceRef as DomainEvidenceRef } from "../domain/schema.js";
import {
  findSensitivePatterns,
  type RedactedValue,
  type RedactionOptions,
  redactText,
  redactValue,
} from "./redaction.js";

export type EvidenceRef = DomainEvidenceRef;
export type EvidenceKind = EvidenceRef["kind"];

export interface EventAppendReceipt {
  readonly eventId: string;
  readonly relativePath: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly lineSha256: string;
}

export interface EvidenceEventInput extends Readonly<Record<string, unknown>> {
  readonly runId: string;
  readonly kind?: string;
  readonly type?: string;
  readonly summary?: string;
  readonly eventId?: string;
  readonly timestamp?: string;
}

export interface EvidenceWriterOptions {
  readonly rootDirectory: string;
  readonly eventsPath?: string;
  readonly redaction?: RedactionOptions;
  readonly maxEventBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly now?: () => Date;
}

export interface ScreenshotWriteOptions {
  /** The caller confirms its surface adapter already masked every sensitive region. */
  readonly redactionVerified: true;
  readonly mimeType?: "image/png" | "image/jpeg" | "image/webp";
}

export interface Canary {
  /** Non-sensitive label safe to print in CI output. */
  readonly id: string;
  readonly value: string;
}

export interface CanaryFinding {
  readonly canaryId: string;
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
}

export interface CanaryScanOptions {
  readonly ignoredDirectoryNames?: ReadonlySet<string>;
  readonly maxFileBytes?: number;
  readonly caseSensitive?: boolean;
}

export interface SensitiveFileFinding {
  readonly relativePath: string;
  readonly patterns: ReturnType<typeof findSensitivePatterns>;
}

const DEFAULT_MAX_EVENT_BYTES = 256 * 1_024;
const DEFAULT_MAX_ARTIFACT_BYTES = 20 * 1_024 * 1_024;
const DEFAULT_SCAN_FILE_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const SAFE_CANARY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_EVENT_ID = /^[A-Za-z][A-Za-z0-9._-]{1,127}$/u;
const APPEND_NOFOLLOW_FLAGS =
  fileConstants.O_APPEND |
  fileConstants.O_CREAT |
  fileConstants.O_WRONLY |
  (fileConstants.O_NOFOLLOW ?? 0);
const READ_NOFOLLOW_FLAGS = fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isoTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Evidence clock returned an invalid Date.");
  }
  return date.toISOString();
}

function normalizeRelativePath(input: string): string {
  if (
    !input ||
    input.includes("\0") ||
    input.includes("\\") ||
    path.isAbsolute(input) ||
    input.length > 1_024
  ) {
    throw new TypeError("Evidence path must be a bounded POSIX relative path.");
  }

  const normalized = path.posix.normalize(input);
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError("Evidence path cannot escape its run directory.");
  }
  return normalized;
}

function asRecord(value: RedactedValue): Readonly<Record<string, RedactedValue>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function ownDataProperty(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function ownRecord(value: unknown): object | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function pickOwnDataProperties(record: object, keys: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    const value = ownDataProperty(record, key);
    if (value !== undefined) projected[key] = value;
  }
  return projected;
}

const AUDIT_EVENT_BASE_FIELDS = [
  "schemaVersion",
  "eventId",
  "sequence",
  "timestamp",
  "runId",
  "correlationId",
  "sessionId",
  "artifactId",
  "actor",
  "ownerEpoch",
  "type",
  "kind",
] as const;

function projectValueExpression(value: unknown): Record<string, unknown> | undefined {
  const expression = ownRecord(value);
  if (!expression) return undefined;
  const kind = ownDataProperty(expression, "kind");
  if (kind === "input" || kind === "secret_ref") {
    return pickOwnDataProperties(expression, ["kind", "name"]);
  }
  if (kind === "step_output") {
    return pickOwnDataProperties(expression, ["kind", "stepId", "name"]);
  }
  if (kind === "literal") {
    // A literal's value and rationale are intentionally excluded from persistent audit data.
    return pickOwnDataProperties(expression, ["kind", "classification"]);
  }
  return undefined;
}

function projectModelDecision(value: unknown): Record<string, unknown> | undefined {
  const decision = ownRecord(value);
  if (!decision) return undefined;
  const kind = ownDataProperty(decision, "kind");
  const common = pickOwnDataProperties(decision, ["decisionId", "observationId", "kind"]);
  switch (kind) {
    case "set_value": {
      const projected = {
        ...common,
        ...pickOwnDataProperties(decision, ["elementRef"]),
      };
      const expression = projectValueExpression(ownDataProperty(decision, "value"));
      if (expression) projected.value = expression;
      return projected;
    }
    case "activate":
      return { ...common, ...pickOwnDataProperties(decision, ["elementRef"]) };
    case "activate_coordinate":
      return { ...common, ...pickOwnDataProperties(decision, ["x", "y"]) };
    case "wait":
      return { ...common, ...pickOwnDataProperties(decision, ["durationMs"]) };
    case "extract":
      return { ...common, ...pickOwnDataProperties(decision, ["elementRef", "output"]) };
    case "request_help":
      return { ...common, ...pickOwnDataProperties(decision, ["reason"]) };
    case "finish":
      return common;
    default:
      return common;
  }
}

function projectIntervention(value: unknown): Record<string, unknown> | undefined {
  const intervention = ownRecord(value);
  if (!intervention) return undefined;
  return pickOwnDataProperties(intervention, [
    "id",
    "runId",
    "sessionId",
    "reason",
    "currentStepId",
    "allowedActions",
    "evidence",
    "ownerEpoch",
    "createdAt",
  ]);
}

function projectFault(value: unknown): Record<string, unknown> | undefined {
  const fault = ownRecord(value);
  if (!fault) return undefined;
  return pickOwnDataProperties(fault, ["code", "phase", "retryable", "stepId", "evidence"]);
}

function projectPredicateValueExpression(value: unknown): Record<string, unknown> | undefined {
  const expression = ownRecord(value);
  if (!expression) return undefined;
  if (ownDataProperty(expression, "kind") !== "literal") {
    return projectValueExpression(expression);
  }
  return {
    ...pickOwnDataProperties(expression, ["kind", "classification"]),
    value: "[PERSISTENCE-OMITTED]",
    rationale: "Literal omitted from persistent evidence.",
  };
}

function projectPredicateArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const projected: Record<string, unknown>[] = [];
  for (let index = 0; index < Math.min(value.length, 20); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) continue;
    const predicate = projectPredicate(descriptor.value);
    if (predicate) projected.push(predicate);
  }
  return projected;
}

function projectPredicate(value: unknown): Record<string, unknown> | undefined {
  const predicate = ownRecord(value);
  if (!predicate) return undefined;
  const kind = ownDataProperty(predicate, "kind");
  const common = pickOwnDataProperties(predicate, ["kind"]);
  switch (kind) {
    case "target_visible":
      return { ...common, ...pickOwnDataProperties(predicate, ["target", "expected"]) };
    case "target_text_matches": {
      const projected = { ...common, ...pickOwnDataProperties(predicate, ["target"]) };
      const matcher = ownRecord(ownDataProperty(predicate, "matcher"));
      if (matcher) {
        projected.matcher = {
          ...pickOwnDataProperties(matcher, ["mode", "caseSensitive"]),
          value: "[PERSISTENCE-OMITTED]",
        };
      }
      return projected;
    }
    case "target_value_equals": {
      const projected = { ...common, ...pickOwnDataProperties(predicate, ["target"]) };
      const expected = projectPredicateValueExpression(ownDataProperty(predicate, "expected"));
      if (expected) projected.expected = expected;
      return projected;
    }
    case "route_matches":
      return { ...common, ...pickOwnDataProperties(predicate, ["route"]) };
    case "output_valid":
      return { ...common, ...pickOwnDataProperties(predicate, ["output"]) };
    case "surface_fingerprint":
      return { ...common, ...pickOwnDataProperties(predicate, ["minimumScore"]) };
    case "all":
    case "any": {
      return {
        ...common,
        predicates: projectPredicateArray(ownDataProperty(predicate, "predicates")),
      };
    }
    case "not": {
      const projected = projectPredicate(ownDataProperty(predicate, "predicate"));
      return projected ? { ...common, predicate: projected } : common;
    }
    default:
      return common;
  }
}

/**
 * Persist an audit-safe projection for event classes that routinely carry raw
 * page or model text. Runtime objects remain unchanged for live control flow.
 */
function projectPersistentEvent(event: object, eventType: string): object {
  if (eventType === "observation.captured") {
    return pickOwnDataProperties(event, [
      ...AUDIT_EVENT_BASE_FIELDS,
      "observationId",
      "route",
      "surfaceFingerprint",
      "elementCount",
      "evidenceId",
    ]);
  }

  if (eventType === "model.decision") {
    const projected = pickOwnDataProperties(event, [
      ...AUDIT_EVENT_BASE_FIELDS,
      "provider",
      "modelId",
    ]);
    const decision = projectModelDecision(ownDataProperty(event, "decision"));
    if (decision) projected.decision = decision;
    return projected;
  }

  if (eventType === "action.completed") {
    return pickOwnDataProperties(event, [
      ...AUDIT_EVENT_BASE_FIELDS,
      "command",
      "stepId",
      "durationMs",
      "changedSurface",
      "previousObservationId",
      "observationId",
    ]);
  }

  if (eventType === "recovery.attempted") {
    return pickOwnDataProperties(event, [...AUDIT_EVENT_BASE_FIELDS, "code", "attempt"]);
  }

  if (eventType === "predicate.evaluated") {
    const projected = pickOwnDataProperties(event, [...AUDIT_EVENT_BASE_FIELDS, "passed"]);
    const predicate = projectPredicate(ownDataProperty(event, "predicate"));
    if (predicate) projected.predicate = predicate;
    projected.observedSummary = "Predicate observation omitted from persistent evidence.";
    return projected;
  }

  if (eventType === "control.transferred") {
    return {
      ...pickOwnDataProperties(event, [...AUDIT_EVENT_BASE_FIELDS, "from", "to", "newOwnerEpoch"]),
      reason: "Control reason omitted from persistent evidence.",
    };
  }

  if (
    eventType === "intervention.created" ||
    eventType === "replay.intervention" ||
    eventType === "replay.intervention.resumed"
  ) {
    const projected = pickOwnDataProperties(event, [
      ...AUDIT_EVENT_BASE_FIELDS,
      "code",
      "status",
      "modelCalls",
      "stepId",
      "priorOwnerEpoch",
      "newOwnerEpoch",
      "observationId",
      "checkpointPassed",
    ]);
    const intervention = projectIntervention(ownDataProperty(event, "intervention"));
    if (intervention) projected.intervention = intervention;
    return projected;
  }

  if (eventType === "fault.raised") {
    const projected = pickOwnDataProperties(event, [
      ...AUDIT_EVENT_BASE_FIELDS,
      "code",
      "phase",
      "retryable",
      "stepId",
    ]);
    const fault = projectFault(ownDataProperty(event, "fault"));
    if (fault) projected.fault = fault;
    return projected;
  }

  return event;
}

/** Produce a bounded, single-line summary without reflecting unredacted values. */
export function summarizeEvent(input: unknown, maxLength = 240): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 32 || maxLength > 4_096) {
    throw new RangeError("maxLength must be a safe integer between 32 and 4096.");
  }

  const redacted = redactValue(input);
  let summary: string;
  if (typeof redacted === "string") {
    summary = redacted;
  } else {
    const record = asRecord(redacted);
    const orderedKeys = [
      "type",
      "kind",
      "actor",
      "command",
      "action",
      "effect",
      "status",
      "code",
      "summary",
      "receiptSummary",
    ];
    const parts = record
      ? orderedKeys.flatMap((key) => {
          const value = record[key];
          return typeof value === "string" || typeof value === "number"
            ? [`${key}=${String(value)}`]
            : [];
        })
      : [];
    summary = parts.length > 0 ? parts.join(" | ") : "structured event";
  }

  const compact = redactText(summary).replaceAll(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function validateScreenshot(bytes: Uint8Array, mimeType: ScreenshotWriteOptions["mimeType"]): void {
  if (mimeType === "image/png") {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (pngSignature.some((byte, index) => bytes[index] !== byte)) {
      throw new TypeError("Screenshot bytes do not have a PNG signature.");
    }
    return;
  }
  if (mimeType === "image/jpeg") {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
      throw new TypeError("Screenshot bytes do not have a JPEG signature.");
    }
    return;
  }
  if (mimeType === "image/webp") {
    const header = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
    if (!header.startsWith("RIFF") || header.slice(8, 12) !== "WEBP") {
      throw new TypeError("Screenshot bytes do not have a WebP signature.");
    }
  }
}

function extensionForMimeType(mimeType: NonNullable<ScreenshotWriteOptions["mimeType"]>): string {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
  }
}

/**
 * Append-only evidence writer. JSON is redacted before serialization; screenshot
 * bytes must be supplied by a masking-aware surface adapter.
 */
export class EvidenceWriter {
  readonly rootDirectory: string;
  readonly eventsPath: string;
  private readonly redaction: RedactionOptions;
  private readonly maxEventBytes: number;
  private readonly maxArtifactBytes: number;
  private readonly now: () => Date;
  private readonly initialized: Promise<string>;
  private appendTail: Promise<void> = Promise.resolve();

  constructor(options: EvidenceWriterOptions) {
    if (!path.isAbsolute(options.rootDirectory)) {
      throw new TypeError("Evidence rootDirectory must be absolute.");
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.eventsPath = normalizeRelativePath(options.eventsPath ?? "events.redacted.jsonl");
    this.redaction = options.redaction ?? {};
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.now = options.now ?? (() => new Date());

    for (const [label, value] of [
      ["maxEventBytes", this.maxEventBytes],
      ["maxArtifactBytes", this.maxArtifactBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer.`);
      }
    }

    this.initialized = this.initialize();
  }

  private async initialize(): Promise<string> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const rootMetadata = await lstat(this.rootDirectory);
    if (rootMetadata.isSymbolicLink()) {
      throw new Error("Evidence rootDirectory itself must not be a symlink.");
    }
    return realpath(this.rootDirectory);
  }

  private async resolveOutput(
    relativePath: string,
  ): Promise<{ absolute: string; relative: string }> {
    const canonicalRoot = await this.initialized;
    const relative = normalizeRelativePath(relativePath);
    const absolute = path.resolve(canonicalRoot, relative);
    const prefix = `${canonicalRoot}${path.sep}`;
    if (!absolute.startsWith(prefix)) {
      throw new TypeError("Evidence path escaped its run directory.");
    }

    let parent = canonicalRoot;
    for (const segment of relative.split("/").slice(0, -1)) {
      const candidate = path.join(parent, segment);
      try {
        await mkdir(candidate, { mode: 0o700 });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("Evidence paths cannot contain symlinks or non-directory parents.");
      }
      parent = candidate;
    }
    const canonicalParent = await realpath(parent);
    if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(prefix)) {
      throw new Error("Evidence parent resolves outside the run directory.");
    }

    let cursor = parent;
    while (cursor !== canonicalRoot) {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        throw new Error("Evidence paths cannot contain symlinks.");
      }
      cursor = path.dirname(cursor);
    }
    return { absolute, relative };
  }

  protected async writeImmutableBytes(
    relativePath: string,
    bytes: Uint8Array,
    kind: EvidenceKind,
    mimeType: string,
  ): Promise<EvidenceRef> {
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxArtifactBytes) {
      throw new RangeError("Evidence artifact size is outside the configured bounds.");
    }

    const output = await this.resolveOutput(relativePath);
    const temporary = `${output.absolute}.tmp-${randomUUID()}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      // link is atomic and refuses to replace an existing immutable evidence file.
      await link(temporary, output.absolute);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }

    const digest = sha256(bytes);
    return {
      id: `ev_${digest.slice(0, 24)}`,
      kind,
      relativePath: output.relative,
      sha256: digest,
      byteLength: bytes.byteLength,
      mimeType,
      createdAt: isoTimestamp(this.now()),
    };
  }

  private enqueueAppend<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.appendTail.then(operation, operation);
    this.appendTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async appendEvent(event: AutomationEvent | EvidenceEventInput): Promise<EventAppendReceipt> {
    return this.enqueueAppend(async () => {
      const typeValue = ownDataProperty(event, "type") ?? ownDataProperty(event, "kind");
      const runIdValue = ownDataProperty(event, "runId");
      if (
        typeof typeValue !== "string" ||
        !typeValue.trim() ||
        typeof runIdValue !== "string" ||
        !runIdValue.trim()
      ) {
        throw new TypeError("Evidence events require a type (or kind) and runId.");
      }

      const eventIdValue = ownDataProperty(event, "eventId");
      const timestampValue = ownDataProperty(event, "timestamp");
      const eventId =
        typeof eventIdValue === "string" && eventIdValue.trim()
          ? eventIdValue
          : `evt_${randomUUID()}`;
      if (!SAFE_EVENT_ID.test(eventId)) {
        throw new TypeError("Evidence eventId is not a safe identifier.");
      }
      const timestamp =
        typeof timestampValue === "string" && Number.isFinite(Date.parse(timestampValue))
          ? new Date(timestampValue).toISOString()
          : isoTimestamp(this.now());
      const redactedEvent = redactValue(projectPersistentEvent(event, typeValue), this.redaction);
      const redactedRecord = asRecord(redactedEvent);
      if (!redactedRecord) {
        throw new TypeError("Evidence event must be a structured object.");
      }
      const line = `${JSON.stringify({ ...redactedRecord, eventId, timestamp })}\n`;
      const bytes = Buffer.from(line, "utf8");
      if (bytes.byteLength > this.maxEventBytes) {
        throw new RangeError("Redacted evidence event exceeds maxEventBytes.");
      }

      const output = await this.resolveOutput(this.eventsPath);
      const handle = await open(output.absolute, APPEND_NOFOLLOW_FLAGS, 0o600);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
          throw new Error("Evidence event target must be a regular file.");
        }
        const result = await handle.write(bytes);
        await handle.sync();
        if (result.bytesWritten !== bytes.byteLength) {
          throw new Error("Evidence event append was incomplete.");
        }
        return {
          eventId,
          relativePath: output.relative,
          byteOffset: metadata.size,
          byteLength: bytes.byteLength,
          lineSha256: sha256(bytes),
        };
      } finally {
        await handle.close();
      }
    });
  }

  async writeJson(
    relativePath: string,
    value: unknown,
    kind: EvidenceKind = "summary",
  ): Promise<EvidenceRef> {
    const redacted = redactValue(value, this.redaction);
    const bytes = Buffer.from(`${JSON.stringify(redacted, null, 2)}\n`, "utf8");
    return this.writeImmutableBytes(relativePath, bytes, kind, "application/json");
  }

  async writeSanitizedText(relativePath: string, value: string): Promise<EvidenceRef> {
    const bytes = Buffer.from(`${redactText(value)}\n`, "utf8");
    return this.writeImmutableBytes(relativePath, bytes, "summary", "text/plain; charset=utf-8");
  }

  async writeScreenshot(
    relativePath: string,
    buffer: Uint8Array,
    options: ScreenshotWriteOptions,
  ): Promise<EvidenceRef> {
    if (options.redactionVerified !== true) {
      throw new TypeError("Screenshot evidence requires an explicit redaction verification.");
    }
    const mimeType = options.mimeType ?? "image/png";
    const normalizedPath = normalizeRelativePath(relativePath);
    if (path.posix.extname(normalizedPath).toLowerCase() !== extensionForMimeType(mimeType)) {
      throw new TypeError("Screenshot extension does not match its declared MIME type.");
    }
    validateScreenshot(buffer, mimeType);
    return this.writeImmutableBytes(normalizedPath, Buffer.from(buffer), "screenshot", mimeType);
  }

  /** Create a stable ref for the current append-only event log after all appends finish. */
  async eventLogRef(): Promise<EvidenceRef> {
    await this.appendTail;
    const output = await this.resolveOutput(this.eventsPath);
    const handle = await open(output.absolute, READ_NOFOLLOW_FLAGS);
    let bytes: Buffer;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new Error("Evidence event target must be a regular file.");
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const digest = sha256(bytes);
    return {
      id: `ev_${digest.slice(0, 24)}`,
      kind: "event_log",
      relativePath: output.relative,
      sha256: digest,
      byteLength: bytes.byteLength,
      mimeType: "application/x-ndjson",
      createdAt: isoTimestamp(this.now()),
    };
  }
}

function isProbablyText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8_192));
  if (sample.includes(0)) {
    return false;
  }
  if (sample.byteLength === 0) {
    return true;
  }
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || byte >= 32) {
      printable += 1;
    }
  }
  return printable / sample.byteLength >= 0.85;
}

async function textFiles(
  rootDirectory: string,
  ignoredDirectoryNames: ReadonlySet<string>,
  maxFileBytes: number,
): Promise<readonly { absolute: string; relative: string; text: string }[]> {
  const root = path.resolve(rootDirectory);
  const rootMetadata = await stat(root);
  if (!rootMetadata.isDirectory()) {
    throw new TypeError("Canary scan root must be a directory.");
  }

  const files: { absolute: string; relative: string; text: string }[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) {
          pending.push(absolute);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const metadata = await stat(absolute);
      if (metadata.size > maxFileBytes) {
        continue;
      }
      const bytes = await readFile(absolute);
      if (!isProbablyText(bytes)) {
        continue;
      }
      files.push({
        absolute,
        relative: path.relative(root, absolute).split(path.sep).join("/"),
        text: bytes.toString("utf8"),
      });
    }
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  return files;
}

function validateScanOptions(options: CanaryScanOptions): {
  ignoredDirectoryNames: ReadonlySet<string>;
  maxFileBytes: number;
  caseSensitive: boolean;
} {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_SCAN_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new RangeError("maxFileBytes must be a positive safe integer.");
  }
  return {
    ignoredDirectoryNames: options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORIES,
    maxFileBytes,
    caseSensitive: options.caseSensitive ?? true,
  };
}

/** Scan likely-text files without ever returning the canary value or matching line. */
export async function scanTextCanaries(
  rootDirectory: string,
  canaries: readonly Canary[],
  options: CanaryScanOptions = {},
): Promise<CanaryFinding[]> {
  if (canaries.length === 0) {
    return [];
  }
  for (const canary of canaries) {
    if (!SAFE_CANARY_ID.test(canary.id) || canary.value.length < 4) {
      throw new TypeError("Canaries require a safe ID and a value of at least four characters.");
    }
  }

  const validated = validateScanOptions(options);
  const files = await textFiles(
    rootDirectory,
    validated.ignoredDirectoryNames,
    validated.maxFileBytes,
  );
  const findings: CanaryFinding[] = [];
  for (const file of files) {
    const haystack = validated.caseSensitive ? file.text : file.text.toLocaleLowerCase("en-US");
    for (const canary of canaries) {
      const needle = validated.caseSensitive
        ? canary.value
        : canary.value.toLocaleLowerCase("en-US");
      let offset = haystack.indexOf(needle);
      while (offset >= 0) {
        const prefix = file.text.slice(0, offset);
        const lines = prefix.split("\n");
        findings.push({
          canaryId: canary.id,
          relativePath: file.relative,
          line: lines.length,
          column: (lines.at(-1)?.length ?? 0) + 1,
        });
        offset = haystack.indexOf(needle, offset + Math.max(1, needle.length));
      }
    }
  }
  return findings;
}

export async function assertNoTextCanaries(
  rootDirectory: string,
  canaries: readonly Canary[],
  options?: CanaryScanOptions,
): Promise<void> {
  const findings = await scanTextCanaries(rootDirectory, canaries, options);
  if (findings.length > 0) {
    const ids = [...new Set(findings.map((finding) => finding.canaryId))].join(", ");
    throw new Error(`Sensitive canaries detected (${findings.length} matches; IDs: ${ids}).`);
  }
}

/** A broader defensive scan; findings contain pattern names and counts, never matches. */
export async function scanTextForSensitivePatterns(
  rootDirectory: string,
  options: CanaryScanOptions = {},
): Promise<SensitiveFileFinding[]> {
  const validated = validateScanOptions(options);
  const files = await textFiles(
    rootDirectory,
    validated.ignoredDirectoryNames,
    validated.maxFileBytes,
  );
  return files.flatMap((file) => {
    const patterns = findSensitivePatterns(file.text);
    return patterns.length > 0 ? [{ relativePath: file.relative, patterns }] : [];
  });
}
