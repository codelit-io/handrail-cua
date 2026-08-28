import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import { z } from "zod";
import {
  ArtifactApprovalSchema,
  CapabilityArtifactSchema,
  CommandKindSchema,
  EffectClassSchema,
  EvidenceRefSchema,
  IdentifierSchema,
  InterventionReasonSchema,
  RunResultSchema,
  Sha256Schema,
} from "../src/domain/schema.js";
import {
  assertArtifactApproval,
  computeArtifactApprovalDigest,
  validateArtifactOutputs,
  verifyArtifactDigest,
} from "../src/runtime/artifact.js";
import { type PersistedAuditEvent, PersistedAuditEventSchema } from "../src/runtime/evidence.js";
import {
  findSensitivePatterns,
  INTERNAL_REDACTION,
  PII_REDACTION,
  SECRET_REDACTION,
  type SensitivePatternFinding,
} from "../src/runtime/redaction.js";

const RelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.split("/").some((segment) => !segment || segment === "." || segment === ".."),
    "Evidence paths must be bounded POSIX paths inside the bundle.",
  );

const ScreenshotEvidenceRefSchema = z
  .object({
    relativePath: RelativePathSchema,
    sha256: Sha256Schema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(20 * 1_024 * 1_024),
    mimeType: z.literal("image/png"),
  })
  .strict();

const ManifestRunSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum(["discovery", "replay"]),
    scenario: z.enum(["success", "exception", "handoff"]),
    directory: RelativePathSchema,
    summary: RelativePathSchema,
    summarySha256: Sha256Schema,
    events: RelativePathSchema,
    eventsSha256: Sha256Schema,
    artifact: RelativePathSchema.optional(),
    artifactSha256: Sha256Schema.optional(),
    screenshots: z.array(ScreenshotEvidenceRefSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const hasArtifact = value.artifact !== undefined || value.artifactSha256 !== undefined;
    if ((value.kind === "discovery") !== hasArtifact) {
      context.addIssue({
        code: "custom",
        path: ["artifact"],
        message: "Exactly discovery runs must bind their generated artifact file and hash.",
      });
    }
    if (hasArtifact && (value.artifact === undefined || value.artifactSha256 === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["artifactSha256"],
        message: "Run artifact paths and hashes must be supplied together.",
      });
    }
  });

const EvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal("1.2.0"),
    generatedAt: z.iso.datetime({ offset: true }),
    mode: z.enum(["scripted", "live"]),
    model: z
      .object({
        provider: z.string().min(1).max(120),
        modelId: z.string().min(1).max(200),
        liveModel: z.boolean(),
        transport: z.enum(["native-ollama", "openai-compatible", "scripted"]),
        digest: Sha256Schema.optional(),
      })
      .strict(),
    provenance: z
      .object({
        sourceRevision: z.union([z.literal("working-tree"), z.string().regex(/^[a-f0-9]{40}$/u)]),
        sourceTreeSha256: Sha256Schema,
        targetFixtureSha256: Sha256Schema,
        nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+(?:[-+].+)?$/u),
        playwrightVersion: z.string().min(1).max(80),
        invocation: z
          .object({
            command: z.enum(["demo:offline", "demo:live"]),
            planner: z.enum(["scripted", "live"]),
            replayRuns: z.number().int().min(1).max(50),
            screenshotModelInput: z.boolean(),
            syntheticTarget: z.boolean(),
            targetSource: z.enum(["bundled-fixture", "external"]),
          })
          .strict(),
      })
      .strict(),
    artifact: RelativePathSchema,
    artifactSha256: Sha256Schema,
    artifactApproval: RelativePathSchema,
    artifactApprovalSha256: Sha256Schema,
    stability: z.object({ path: RelativePathSchema, sha256: Sha256Schema }).strict(),
    runs: z.array(ManifestRunSchema).min(3).max(100),
  })
  .strict();

type ManifestRun = z.infer<typeof ManifestRunSchema>;
type ScreenshotEvidenceRef = z.infer<typeof ScreenshotEvidenceRefSchema>;

const PersistedValueExpressionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("input"), name: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("secret_ref"), name: IdentifierSchema }).strict(),
  z
    .object({ kind: z.literal("step_output"), stepId: IdentifierSchema, name: IdentifierSchema })
    .strict(),
  z
    .object({
      kind: z.literal("literal"),
      classification: z.enum(["public", "internal", "pii", "secret"]),
    })
    .strict(),
]);

const PersistedModelDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      decisionId: IdentifierSchema,
      observationId: IdentifierSchema,
      kind: z.literal("set_value"),
      reasonCode: z.literal("planner_set_value"),
      elementRef: IdentifierSchema,
      value: PersistedValueExpressionSchema,
    })
    .strict(),
  z
    .object({
      decisionId: IdentifierSchema,
      observationId: IdentifierSchema,
      kind: z.literal("activate"),
      reasonCode: z.literal("planner_activate"),
      elementRef: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      decisionId: IdentifierSchema,
      observationId: IdentifierSchema,
      kind: z.literal("activate_coordinate"),
      reasonCode: z.literal("planner_activate_coordinate"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      decisionId: IdentifierSchema,
      observationId: IdentifierSchema,
      kind: z.literal("wait"),
      reasonCode: z.literal("planner_wait"),
      durationMs: z.number().int().min(50).max(5_000),
    })
    .strict(),
  z
    .object({
      decisionId: IdentifierSchema,
      observationId: IdentifierSchema,
      kind: z.literal("extract"),
      reasonCode: z.literal("planner_extract"),
      elementRef: IdentifierSchema,
      output: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      decisionId: IdentifierSchema,
      observationId: IdentifierSchema,
      kind: z.literal("finish"),
      reasonCode: z.literal("planner_finish"),
    })
    .strict(),
  z
    .object({
      decisionId: IdentifierSchema,
      observationId: IdentifierSchema,
      kind: z.literal("request_help"),
      reasonCode: z.literal("planner_request_help"),
      reason: z.enum(["stuck", "unsafe", "expired_session", "risky", "unknown_state"]),
    })
    .strict(),
]);

const DiscoverySummarySchema = z
  .object({
    kind: z.literal("discovery"),
    status: z.literal("succeeded"),
    runId: IdentifierSchema,
    sessionId: z.string().min(2),
    modelCalls: z.number().int().positive(),
    recoveries: z.number().int().min(0),
    evidence: z.array(EvidenceRefSchema).min(1).max(100),
    artifactId: IdentifierSchema,
    artifactDigest: Sha256Schema,
    provenance: z
      .object({
        discoveryRunId: IdentifierSchema,
        provider: z.string().min(1),
        modelId: z.string().min(1),
        promptHash: Sha256Schema,
        liveModel: z.boolean(),
        createdAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    outputs: z.record(z.string(), z.unknown()),
  })
  .strict();

const HandoffEvidenceSummarySchema = z
  .object({
    interventionId: IdentifierSchema,
    reason: InterventionReasonSchema,
    originalSessionId: IdentifierSchema,
    resumedSessionId: IdentifierSchema,
    sameSession: z.literal(true),
    automationEpochBefore: z.number().int().min(0),
    operatorEpoch: z.number().int().min(0),
    automationEpochAfter: z.number().int().min(0),
    checkpointPassed: z.literal(true),
    operatorAuditEvents: z.number().int().min(9).max(1_000),
    evidence: z
      .array(EvidenceRefSchema)
      .min(2)
      .max(20)
      .refine(
        (refs) => refs.every((ref) => ref.kind === "screenshot"),
        "Handoff evidence must contain screenshots only.",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.originalSessionId !== value.resumedSessionId) {
      context.addIssue({
        code: "custom",
        path: ["resumedSessionId"],
        message: "Handoff must resume the original live session.",
      });
    }
    if (
      value.automationEpochBefore >= value.operatorEpoch ||
      value.operatorEpoch >= value.automationEpochAfter
    ) {
      context.addIssue({
        code: "custom",
        path: ["automationEpochAfter"],
        message: "Handoff authority epochs must advance automation -> operator -> automation.",
      });
    }
  });

const DiscoveryStartedEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("run.started"),
  sessionId: IdentifierSchema,
  actor: z.literal("automation"),
  mode: z.literal("discovery"),
}).strict();

const DiscoveryObservationEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("observation.captured"),
  sessionId: IdentifierSchema,
  actor: z.literal("automation"),
  observationId: IdentifierSchema,
  route: z.string().startsWith("/").max(2_000),
  surfaceFingerprint: Sha256Schema,
  elementCount: z.number().int().min(0).max(100_000),
  evidenceId: IdentifierSchema.optional(),
}).strict();

const DiscoveryModelDecisionEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("model.decision"),
  sessionId: IdentifierSchema,
  actor: z.literal("model"),
  provider: z.string().trim().min(1).max(120),
  modelId: z.string().trim().min(1).max(200),
  decision: PersistedModelDecisionSchema,
}).strict();

const DiscoveryActionDispatchedEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("action.dispatched"),
  sessionId: IdentifierSchema,
  actor: z.literal("automation"),
  command: CommandKindSchema,
  effect: EffectClassSchema,
  target: IdentifierSchema.optional(),
}).strict();

const DiscoveryActionCompletedEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("action.completed"),
  sessionId: IdentifierSchema,
  actor: z.literal("automation"),
  command: CommandKindSchema,
  durationMs: z.number().int().min(0),
  changedSurface: z.boolean(),
  previousObservationId: IdentifierSchema,
  observationId: IdentifierSchema,
}).strict();

const DiscoveryRecoveryEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("recovery.attempted"),
  sessionId: IdentifierSchema,
  actor: z.literal("automation"),
  code: IdentifierSchema,
  attempt: z.number().int().positive(),
}).strict();

const DiscoveryCompletedEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("run.completed"),
  sessionId: IdentifierSchema,
  actor: z.literal("automation"),
  status: z.literal("succeeded"),
  artifactId: IdentifierSchema,
  artifactDigest: Sha256Schema,
  modelCalls: z.number().int().positive(),
}).strict();

const OperatorAuditEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("operator.audit"),
  sessionId: IdentifierSchema,
  actorId: IdentifierSchema,
  action: z.enum([
    "automation_paused",
    "control_claim_authorized",
    "control_claimed",
    "operator_action_authorized",
    "operator_clicked",
    "operator_typed",
    "operator_pressed_key",
    "evidence_captured",
    "resume_checkpoint_failed",
    "return_control_authorized",
    "control_returned",
    "audit_sink_failed",
  ]),
  details: z.record(z.string(), z.unknown()),
}).strict();

const ReplayStartedEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("replay.started"),
  actor: z.literal("automation"),
  sessionId: IdentifierSchema,
  artifactId: IdentifierSchema,
  artifactDigest: Sha256Schema,
  artifactApprovalMode: z.enum(["strict", "non_strict"]),
  artifactApprovalDigest: Sha256Schema.optional(),
  modelCalls: z.literal(0),
}).strict();

const ReplayStepAttemptEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("replay.step.attempt"),
  actor: z.literal("automation"),
  stepId: IdentifierSchema,
  command: CommandKindSchema,
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  modelCalls: z.literal(0),
}).strict();

const ReplayStepCompletedEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("replay.step.completed"),
  actor: z.literal("automation"),
  stepId: IdentifierSchema,
  command: CommandKindSchema,
  attempt: z.number().int().positive(),
  modelCalls: z.literal(0),
}).strict();

const ReplayStepRetryEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("replay.step.retry"),
  actor: z.literal("automation"),
  stepId: IdentifierSchema,
  attempt: z.number().int().positive(),
  retryKind: z.enum(["target_not_found", "postcondition_timeout", "known_transient"]),
  modelCalls: z.literal(0),
}).strict();

const ReplaySurfaceRecoveredEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("replay.surface.recovered"),
  actor: z.literal("automation"),
  code: IdentifierSchema,
  checks: z.number().int().positive(),
  modelCalls: z.literal(0),
}).strict();

const ReplayInterventionEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("replay.intervention"),
  actor: z.literal("automation"),
  sessionId: IdentifierSchema,
  code: IdentifierSchema,
  modelCalls: z.literal(0),
}).strict();

const ReplayFailedEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("replay.failed"),
  actor: z.literal("automation"),
  sessionId: IdentifierSchema,
  code: IdentifierSchema,
  modelCalls: z.literal(0),
}).strict();

const ReplayResumedEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("replay.intervention.resumed"),
  actor: z.literal("automation"),
  sessionId: IdentifierSchema,
  priorOwnerEpoch: z.number().int().min(0),
  newOwnerEpoch: z.number().int().min(0),
  checkpointPassed: z.literal(true),
  modelCalls: z.literal(0),
  stepId: IdentifierSchema,
  observationId: IdentifierSchema,
}).strict();

const ReplayCompletedEvidenceEventSchema = PersistedAuditEventSchema.extend({
  type: z.literal("replay.completed"),
  actor: z.literal("automation"),
  status: z.enum(["succeeded", "business_outcome", "needs_intervention", "failed"]),
  durationMs: z.number().int().min(0),
  modelCalls: z.literal(0),
}).strict();

const ReplaySummarySchema = z
  .object({
    kind: z.literal("replay"),
    scenario: z.enum(["success", "exception", "handoff"]),
    result: RunResultSchema,
    handoff: HandoffEvidenceSummarySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.scenario === "handoff") !== Boolean(value.handoff)) {
      context.addIssue({
        code: "custom",
        path: ["handoff"],
        message: "A handoff summary is required only for handoff replay scenarios.",
      });
    }
  });

const StabilitySchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    artifactId: IdentifierSchema,
    artifactDigest: Sha256Schema,
    requestedRuns: z.number().int().positive(),
    completedRuns: z.number().int().positive(),
    succeeded: z.number().int().min(0),
    successRate: z.number().min(0).max(1),
    allZeroModelCalls: z.boolean(),
    totalModelCalls: z.number().int().min(0),
    latencyMs: z
      .object({
        min: z.number().min(0),
        max: z.number().min(0),
        mean: z.number().min(0),
        p50: z.number().min(0),
        p95: z.number().min(0),
      })
      .strict(),
    runs: z.array(
      z
        .object({
          runId: IdentifierSchema,
          status: z.enum(["succeeded", "business_outcome", "needs_intervention", "failed"]),
          durationMs: z.number().min(0),
          modelCalls: z.number().int().min(0),
        })
        .strict(),
    ),
  })
  .strict();

const FORBIDDEN_FILE =
  /(?:provider-(?:request|response)\.json|(?:prompt|transcript)s?\.(?:jsonl?|md|txt)$|storage-state|\.har$|\.trace\.zip$|\.base64$)/iu;
const TEXT_FILE = /\.(?:json|jsonl|md|txt|toml|ya?ml)$/iu;
const ALLOWED_BUNDLE_FILE = /\.(?:json|jsonl|md|png)$/iu;
const READ_NOFOLLOW_FLAGS = fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_MAX_DIMENSION = 16_384;
const PNG_MAX_PIXELS = 50_000_000;
const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (PNG_CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertValidPng(bytes: Buffer, label: string): void {
  if (!bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} does not have a valid PNG signature.`);
  }

  let offset = PNG_SIGNATURE.byteLength;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let requiresPalette = false;
  let sawHeader = false;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawEnd = false;
  const compressed: Buffer[] = [];

  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) {
      throw new Error(`${label} is not a valid PNG: truncated chunk header.`);
    }
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.byteLength) {
      throw new Error(`${label} is not a valid PNG: truncated chunk payload.`);
    }
    const typeBytes = bytes.subarray(typeStart, dataStart);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(type)) {
      throw new Error(`${label} is not a valid PNG: malformed chunk type.`);
    }
    const data = bytes.subarray(dataStart, dataEnd);
    const declaredCrc = bytes.readUInt32BE(dataEnd);
    if (pngCrc32(bytes.subarray(typeStart, dataEnd)) !== declaredCrc) {
      throw new Error(`${label} is not a valid PNG: ${type} CRC mismatch.`);
    }

    if (!sawHeader && type !== "IHDR") {
      throw new Error(`${label} is not a valid PNG: IHDR must be first.`);
    }
    if (type === "IHDR") {
      if (sawHeader || length !== 13) {
        throw new Error(`${label} is not a valid PNG: invalid IHDR.`);
      }
      sawHeader = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8] ?? 0;
      const colorType = data[9] ?? 255;
      const validDepths: Readonly<Record<number, readonly number[]>> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      const channels: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      if (
        width < 1 ||
        height < 1 ||
        width > PNG_MAX_DIMENSION ||
        height > PNG_MAX_DIMENSION ||
        width * height > PNG_MAX_PIXELS ||
        !(validDepths[colorType]?.includes(bitDepth) ?? false) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        throw new Error(`${label} is not a valid PNG: unsupported or unsafe IHDR.`);
      }
      bitsPerPixel = (channels[colorType] ?? 0) * bitDepth;
      requiresPalette = colorType === 3;
    } else if (type === "PLTE") {
      if (sawImageData || sawPalette || length === 0 || length % 3 !== 0 || length > 768) {
        throw new Error(`${label} is not a valid PNG: invalid PLTE.`);
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (!sawHeader || imageDataEnded || length === 0) {
        throw new Error(`${label} is not a valid PNG: invalid IDAT sequence.`);
      }
      sawImageData = true;
      compressed.push(data);
    } else if (type === "IEND") {
      if (!sawImageData || sawEnd || length !== 0) {
        throw new Error(`${label} is not a valid PNG: invalid IEND.`);
      }
      sawEnd = true;
      offset = chunkEnd;
      if (offset !== bytes.byteLength) {
        throw new Error(`${label} is not a valid PNG: trailing bytes after IEND.`);
      }
      break;
    } else {
      if (sawImageData) imageDataEnded = true;
      if ((typeBytes[0] ?? 0) >= 0x41 && (typeBytes[0] ?? 0) <= 0x5a) {
        throw new Error(`${label} is not a valid PNG: unknown critical chunk ${type}.`);
      }
    }
    offset = chunkEnd;
  }

  if (!sawHeader || !sawImageData || !sawEnd || (requiresPalette && !sawPalette)) {
    throw new Error(`${label} is not a valid PNG: missing required chunks.`);
  }

  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const expectedInflatedLength = height * (rowBytes + 1);
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedInflatedLength });
  } catch (error) {
    throw new Error(`${label} is not a valid PNG: IDAT decompression failed.`, { cause: error });
  }
  if (inflated.byteLength !== expectedInflatedLength) {
    throw new Error(`${label} is not a valid PNG: unexpected decompressed image size.`);
  }
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[row * (rowBytes + 1)];
    if (filter === undefined || filter > 4) {
      throw new Error(`${label} is not a valid PNG: invalid scanline filter.`);
    }
  }
}
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function computedLatency(runs: z.infer<typeof StabilitySchema>["runs"]) {
  const latencies = runs.map((run) => run.durationMs).sort((left, right) => left - right);
  const mean =
    latencies.length === 0
      ? 0
      : Number(
          (latencies.reduce((total, duration) => total + duration, 0) / latencies.length).toFixed(
            2,
          ),
        );
  return {
    min: latencies[0] ?? 0,
    max: latencies.at(-1) ?? 0,
    mean,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
  };
}

export interface EvidenceValidationOptions {
  readonly allowScriptedDiscovery?: boolean;
}

export interface EvidenceValidationReport {
  readonly root: string;
  readonly files: number;
  readonly runs: number;
  readonly discoveryRunId: string;
  readonly replayRunIds: readonly string[];
  readonly artifactDigest: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requireRegularFile(absolutePath: string, label: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolutePath, READ_NOFOLLOW_FLAGS);
  } catch {
    throw new Error(`${label} must be a readable, regular, non-symlink file.`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular, non-symlink file.`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength === 0) throw new Error(`${label} cannot be empty.`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function requireDirectory(absolutePath: string, label: string): Promise<void> {
  const metadata = await lstat(absolutePath).catch(() => undefined);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory.`);
  }
}

function inside(root: string, relativePath: string): string {
  const parsed = RelativePathSchema.parse(relativePath);
  const absolute = path.resolve(root, ...parsed.split("/"));
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Evidence path ${relativePath} escapes the bundle root.`);
  }
  return absolute;
}

async function jsonFile(absolutePath: string, label: string): Promise<unknown> {
  const bytes = await requireRegularFile(absolutePath, label);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

interface EventLogValidation {
  readonly count: number;
  readonly modelDecisions: number;
  readonly operatorAuditEvents: number;
  readonly events: readonly PersistedAuditEvent[];
  readonly terminalModelCalls?: number;
}

function assertTypedEvidenceEvent(
  event: PersistedAuditEvent,
  kind: ManifestRun["kind"],
  label: string,
): void {
  try {
    if (kind === "discovery") {
      switch (event.type) {
        case "run.started":
          DiscoveryStartedEvidenceEventSchema.parse(event);
          return;
        case "observation.captured":
          DiscoveryObservationEvidenceEventSchema.parse(event);
          return;
        case "model.decision":
          DiscoveryModelDecisionEvidenceEventSchema.parse(event);
          return;
        case "action.dispatched":
          DiscoveryActionDispatchedEvidenceEventSchema.parse(event);
          return;
        case "action.completed":
          DiscoveryActionCompletedEvidenceEventSchema.parse(event);
          return;
        case "recovery.attempted":
          DiscoveryRecoveryEvidenceEventSchema.parse(event);
          return;
        case "run.completed":
          DiscoveryCompletedEvidenceEventSchema.parse(event);
          return;
        default:
          throw new TypeError(`unknown discovery event ${event.type}`);
      }
    }

    switch (event.type) {
      case "replay.started":
        ReplayStartedEvidenceEventSchema.parse(event);
        return;
      case "replay.step.attempt":
        ReplayStepAttemptEvidenceEventSchema.parse(event);
        return;
      case "replay.step.completed":
        ReplayStepCompletedEvidenceEventSchema.parse(event);
        return;
      case "replay.step.retry":
        ReplayStepRetryEvidenceEventSchema.parse(event);
        return;
      case "replay.surface.recovered":
        ReplaySurfaceRecoveredEvidenceEventSchema.parse(event);
        return;
      case "replay.intervention":
        ReplayInterventionEvidenceEventSchema.parse(event);
        return;
      case "replay.intervention.resumed":
        ReplayResumedEvidenceEventSchema.parse(event);
        return;
      case "replay.failed":
        ReplayFailedEvidenceEventSchema.parse(event);
        return;
      case "operator.audit":
        OperatorAuditEvidenceEventSchema.parse(event);
        return;
      case "replay.completed":
        ReplayCompletedEvidenceEventSchema.parse(event);
        return;
      default:
        throw new TypeError(`unknown replay event ${event.type}`);
    }
  } catch {
    throw new Error(`${label} event ${event.sequence} violates its typed ${kind} event contract.`);
  }
}

async function validateJsonLines(
  absolutePath: string,
  label: string,
  expectedRunId: string,
  kind: ManifestRun["kind"],
): Promise<EventLogValidation> {
  const bytes = await requireRegularFile(absolutePath, label);
  const lines = bytes
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error(`${label} must contain at least one event.`);
  const events: PersistedAuditEvent[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      const value = PersistedAuditEventSchema.parse(JSON.parse(line) as unknown);
      if (value.runId !== expectedRunId) throw new TypeError("event runId does not match");
      if (value.correlationId !== expectedRunId) {
        throw new TypeError("event correlationId does not match");
      }
      if (value.sequence !== index) throw new TypeError("event sequence is not contiguous");
      assertTypedEvidenceEvent(value, kind, label);
      events.push(value);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${label} event `)) throw error;
      throw new Error(`${label} line ${index + 1} violates the persisted audit-event contract.`);
    }
  }
  if (new Set(events.map((event) => event.eventId)).size !== events.length) {
    throw new Error(`${label} contains duplicate event IDs.`);
  }
  if (
    events.some(
      (event, index) =>
        index > 0 &&
        Date.parse(event.timestamp) < Date.parse(events[index - 1]?.timestamp ?? event.timestamp),
    )
  ) {
    throw new Error(`${label} event timestamps must be monotonic.`);
  }
  const expectedStart = kind === "discovery" ? "run.started" : "replay.started";
  const expectedTerminal = kind === "discovery" ? "run.completed" : "replay.completed";
  if (events[0]?.type !== expectedStart || events.at(-1)?.type !== expectedTerminal) {
    throw new Error(`${label} must have the expected start and terminal events.`);
  }
  const terminal = events.at(-1);
  const terminalModelCalls = terminal?.modelCalls;
  if (
    terminalModelCalls !== undefined &&
    (!Number.isSafeInteger(terminalModelCalls) || Number(terminalModelCalls) < 0)
  ) {
    throw new Error(`${label} terminal modelCalls must be a non-negative integer.`);
  }
  if (
    kind === "replay" &&
    events.some(
      (event) =>
        event.type === "model.decision" ||
        (event.modelCalls !== undefined && event.modelCalls !== 0),
    )
  ) {
    throw new Error(`${label} replay events must prove zero model calls.`);
  }
  return {
    count: events.length,
    modelDecisions: events.filter((event) => event.type === "model.decision").length,
    operatorAuditEvents: events.filter((event) => event.type === "operator.audit").length,
    events,
    ...(terminalModelCalls === undefined ? {} : { terminalModelCalls: Number(terminalModelCalls) }),
  };
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Evidence cannot contain symlink ${relative}.`);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Evidence contains unsupported filesystem entry ${relative}.`);
    }
  }
  return files.sort();
}

async function treeSha256(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const relative of await walk(root)) {
    hash.update(relative, "utf8");
    hash.update("\0", "utf8");
    hash.update(await requireRegularFile(path.join(root, relative), `Source file ${relative}`));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function gitBytes(repositoryRoot: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd: repositoryRoot, encoding: null, maxBuffer: 32 * 1_024 * 1_024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

/** Hash a committed src tree with the same canonical path-and-bytes framing as treeSha256. */
export async function sourceTreeSha256AtRevision(
  repositoryRoot: string,
  revision: string,
): Promise<string> {
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error("Source revision must be a full 40-character lowercase Git commit ID.");
  }

  let resolved: string;
  try {
    resolved = (await gitBytes(repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`]))
      .toString("utf8")
      .trim();
  } catch {
    throw new Error(`Evidence source revision ${revision} is not an available Git commit.`);
  }
  if (resolved !== revision) {
    throw new Error(`Evidence source revision ${revision} did not resolve to that exact commit.`);
  }

  let names: string[];
  try {
    names = (
      await gitBytes(repositoryRoot, ["ls-tree", "-r", "-z", "--name-only", revision, "--", "src"])
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    throw new Error(`Could not inspect src at evidence source revision ${revision}.`);
  }
  if (names.length === 0) {
    throw new Error(`Evidence source revision ${revision} does not contain a src tree.`);
  }

  const hash = createHash("sha256");
  const seen = new Set<string>();
  for (const repositoryPath of names) {
    if (!repositoryPath.startsWith("src/")) {
      throw new Error(`Git returned a path outside src for evidence source revision ${revision}.`);
    }
    const relative = RelativePathSchema.parse(repositoryPath.slice("src/".length));
    if (seen.has(relative)) {
      throw new Error(`Evidence source revision ${revision} contains a duplicate src path.`);
    }
    seen.add(relative);
    let bytes: Buffer;
    try {
      bytes = await gitBytes(repositoryRoot, ["show", `${revision}:${repositoryPath}`]);
    } catch {
      throw new Error(
        `Could not read ${repositoryPath} from evidence source revision ${revision}.`,
      );
    }
    hash.update(relative, "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

async function validateHashes(
  root: string,
  relativePath: string,
  expected: string,
  label: string,
): Promise<void> {
  const bytes = await requireRegularFile(inside(root, relativePath), label);
  if (sha256(bytes) !== expected) throw new Error(`${label} SHA-256 does not match manifest.`);
}

function summaryScreenshotRefs(
  run: ManifestRun,
  refs: readonly z.infer<typeof EvidenceRefSchema>[],
): ScreenshotEvidenceRef[] {
  return refs
    .filter((ref) => ref.kind === "screenshot")
    .map((ref) =>
      ScreenshotEvidenceRefSchema.parse({
        relativePath: path.posix.join(run.directory, ref.relativePath),
        sha256: ref.sha256,
        byteLength: ref.byteLength,
        mimeType: ref.mimeType,
      }),
    );
}

function replayEvidenceRefs(
  result: z.infer<typeof RunResultSchema>,
): readonly z.infer<typeof EvidenceRefSchema>[] {
  switch (result.status) {
    case "succeeded":
      return result.checkpointEvidence;
    case "business_outcome":
      return result.evidence;
    case "needs_intervention":
      return result.intervention.evidence;
    case "failed":
      return result.error.evidence;
  }
}

export function assertAssignmentOutputContract(
  artifact: z.infer<typeof CapabilityArtifactSchema>,
): void {
  const outputNames = Object.keys(artifact.contract.outputs).sort((left, right) =>
    left.localeCompare(right),
  );
  const output = artifact.contract.outputs.savingsBalance;
  const hasTerminalOutputProof =
    artifact.success.kind === "all" &&
    artifact.success.predicates.some(
      (predicate) => predicate.kind === "output_valid" && predicate.output === "savingsBalance",
    ) &&
    artifact.success.predicates.some(
      (predicate) =>
        predicate.kind === "target_visible" &&
        predicate.target === "output-savingsBalance" &&
        predicate.expected,
    );
  const hasStepOutputProof = artifact.steps.some(
    (step) =>
      step.command === "extract" &&
      step.output === "savingsBalance" &&
      step.postcondition.kind === "output_valid" &&
      step.postcondition.output === "savingsBalance",
  );
  if (
    outputNames.length !== 1 ||
    outputNames[0] !== "savingsBalance" ||
    !output ||
    output.classification !== "internal" ||
    output.validator.kind !== "number" ||
    output.validator.minimum !== 0 ||
    !hasStepOutputProof ||
    !hasTerminalOutputProof
  ) {
    throw new Error(
      "Capability must retain the exact internal savingsBalance output and independent step/terminal proof.",
    );
  }

  const outcome = artifact.contract.outcomes[0];
  if (
    artifact.contract.outcomes.length !== 1 ||
    outcome?.code !== "MEMBER_NOT_FOUND" ||
    outcome.when.kind !== "target_text_matches" ||
    outcome.when.target !== "member-not-found" ||
    outcome.when.matcher.mode !== "exact" ||
    outcome.when.matcher.value !== "No member found." ||
    outcome.when.matcher.caseSensitive
  ) {
    throw new Error(
      "Capability must declare the exact MEMBER_NOT_FOUND outcome and target-text predicate.",
    );
  }
}

export function assertProjectedSuccessOutputs(
  runId: string,
  outputs: Readonly<Record<string, unknown>>,
  artifact: z.infer<typeof CapabilityArtifactSchema>,
): void {
  const names = Object.keys(outputs).sort((left, right) => left.localeCompare(right));
  const expectedNames = Object.keys(artifact.contract.outputs).sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(`Run ${runId} summary violates the exact success output-key contract.`);
  }

  const sensitiveMarkers = {
    internal: INTERNAL_REDACTION,
    pii: PII_REDACTION,
    secret: SECRET_REDACTION,
  } as const;
  const publicOutputSpecifications = Object.fromEntries(
    Object.entries(artifact.contract.outputs).filter(
      ([, spec]) => spec.classification === "public",
    ),
  );
  const publicOutputs = Object.fromEntries(
    Object.keys(publicOutputSpecifications).map((name) => [name, outputs[name]]),
  );
  const hasInvalidSensitiveProjection = Object.entries(artifact.contract.outputs).some(
    ([name, spec]) =>
      spec.classification !== "public" && outputs[name] !== sensitiveMarkers[spec.classification],
  );
  try {
    if (hasInvalidSensitiveProjection) throw new TypeError("invalid redaction marker");
    if (Object.keys(publicOutputSpecifications).length > 0) {
      validateArtifactOutputs(
        {
          ...artifact,
          contract: { ...artifact.contract, outputs: publicOutputSpecifications },
        },
        publicOutputs,
      );
    }
  } catch {
    throw new Error(
      `Run ${runId} summary violates the savingsBalance classification/redaction contract.`,
    );
  }
}

function commandForPersistedDecision(
  decision: z.infer<typeof PersistedModelDecisionSchema>,
): z.infer<typeof CommandKindSchema> | undefined {
  switch (decision.kind) {
    case "set_value":
      return "set_value";
    case "activate":
    case "activate_coordinate":
      return "activate";
    case "wait":
      return "wait_for";
    case "extract":
      return "extract";
    case "finish":
    case "request_help":
      return undefined;
  }
}

function assertDiscoveryLifecycle(
  runId: string,
  summary: z.infer<typeof DiscoverySummarySchema>,
  artifact: z.infer<typeof CapabilityArtifactSchema>,
  eventLog: EventLogValidation,
): void {
  const events = eventLog.events;
  const started = DiscoveryStartedEvidenceEventSchema.parse(events[0]);
  const completed = DiscoveryCompletedEvidenceEventSchema.parse(events.at(-1));
  if (
    started.sessionId !== summary.sessionId ||
    completed.sessionId !== summary.sessionId ||
    completed.artifactId !== artifact.id ||
    completed.artifactDigest !== artifact.digest ||
    completed.modelCalls !== summary.modelCalls
  ) {
    throw new Error(`Discovery ${runId} lifecycle is not bound to its session and artifact.`);
  }
  if (
    events.some(
      (event) =>
        event.sessionId !== summary.sessionId ||
        event.ownerEpoch !== started.ownerEpoch ||
        event.actor === "operator",
    )
  ) {
    throw new Error(`Discovery ${runId} lifecycle changed session or control authority.`);
  }

  let index = 1;
  let currentObservation: z.infer<typeof DiscoveryObservationEvidenceEventSchema>;
  try {
    currentObservation = DiscoveryObservationEvidenceEventSchema.parse(events[index]);
  } catch {
    throw new Error(`Discovery ${runId} must begin with a typed surface observation.`);
  }
  index += 1;
  const observationIds = new Set([currentObservation.observationId]);
  const decisionIds = new Set<string>();
  let actionIndex = 0;
  let recoveryCount = 0;
  let sawFinish = false;

  while (index < events.length - 1) {
    const event = events[index];
    if (!event) break;
    if (event.type === "recovery.attempted") {
      const recovery = DiscoveryRecoveryEvidenceEventSchema.parse(event);
      recoveryCount += 1;
      if (recovery.attempt !== recoveryCount) {
        throw new Error(`Discovery ${runId} recovery attempts are not contiguous.`);
      }
      const observation = DiscoveryObservationEvidenceEventSchema.safeParse(events[index + 1]);
      if (!observation.success || observationIds.has(observation.data.observationId)) {
        throw new Error(`Discovery ${runId} recovery lacks a fresh follow-up observation.`);
      }
      observationIds.add(observation.data.observationId);
      currentObservation = observation.data;
      index += 2;
      continue;
    }
    if (event.type !== "model.decision") {
      throw new Error(
        `Discovery ${runId} lifecycle expected a model decision at sequence ${index}.`,
      );
    }
    const model = DiscoveryModelDecisionEvidenceEventSchema.parse(event);
    if (
      decisionIds.has(model.decision.decisionId) ||
      model.provider !== artifact.provenance.provider ||
      model.modelId !== artifact.provenance.modelId ||
      model.decision.observationId !== currentObservation.observationId
    ) {
      throw new Error(`Discovery ${runId} model decision is not bound to the current observation.`);
    }
    decisionIds.add(model.decision.decisionId);

    const expectedCommand = commandForPersistedDecision(model.decision);
    if (expectedCommand === undefined) {
      if (model.decision.kind !== "finish" || index !== events.length - 2) {
        throw new Error(`Discovery ${runId} did not end with one terminal finish decision.`);
      }
      sawFinish = true;
      index += 1;
      break;
    }

    const dispatched = DiscoveryActionDispatchedEvidenceEventSchema.safeParse(events[index + 1]);
    const observed = DiscoveryObservationEvidenceEventSchema.safeParse(events[index + 2]);
    const actionCompleted = DiscoveryActionCompletedEvidenceEventSchema.safeParse(
      events[index + 3],
    );
    const compiledStep = artifact.steps[actionIndex];
    if (
      !dispatched.success ||
      !observed.success ||
      !actionCompleted.success ||
      !compiledStep ||
      dispatched.data.command !== expectedCommand ||
      dispatched.data.command !== compiledStep.command ||
      dispatched.data.effect !== compiledStep.effect ||
      actionCompleted.data.command !== dispatched.data.command ||
      actionCompleted.data.previousObservationId !== currentObservation.observationId ||
      actionCompleted.data.observationId !== observed.data.observationId ||
      observationIds.has(observed.data.observationId)
    ) {
      throw new Error(
        `Discovery ${runId} does not prove an observation-bound decision/action completion flow.`,
      );
    }
    if (
      ((compiledStep.command === "set_value" || compiledStep.command === "activate") &&
        dispatched.data.target !== compiledStep.target) ||
      (compiledStep.command === "extract" &&
        dispatched.data.target !== compiledStep.extractor.target) ||
      (model.decision.kind === "extract" &&
        (compiledStep.command !== "extract" || model.decision.output !== compiledStep.output))
    ) {
      throw new Error(`Discovery ${runId} action evidence is not bound to its compiled step.`);
    }
    observationIds.add(observed.data.observationId);
    currentObservation = observed.data;
    actionIndex += 1;
    index += 4;
  }

  if (
    !sawFinish ||
    index !== events.length - 1 ||
    actionIndex !== artifact.steps.length ||
    recoveryCount !== summary.recoveries
  ) {
    throw new Error(`Discovery ${runId} lifecycle does not prove its complete compiled workflow.`);
  }
}

function assertReplayLifecycle(
  runId: string,
  result: z.infer<typeof RunResultSchema>,
  artifact: z.infer<typeof CapabilityArtifactSchema>,
  eventLog: EventLogValidation,
): void {
  const events = eventLog.events;
  let stepIndex = 0;
  let pendingAttempt: z.infer<typeof ReplayStepAttemptEvidenceEventSchema> | undefined;
  let expectedRetryAttempt: number | undefined;
  let resumedInterventions = 0;

  for (const event of events.slice(1, -1)) {
    const step = artifact.steps[stepIndex];
    switch (event.type) {
      case "replay.step.attempt": {
        const attempt = ReplayStepAttemptEvidenceEventSchema.parse(event);
        if (
          !step ||
          pendingAttempt ||
          attempt.stepId !== step.id ||
          attempt.command !== step.command ||
          attempt.maxAttempts !== step.retry.maxAttempts ||
          attempt.attempt > attempt.maxAttempts ||
          (expectedRetryAttempt === undefined
            ? attempt.attempt !== 1
            : attempt.attempt !== expectedRetryAttempt)
        ) {
          throw new Error(
            `Replay ${runId} step attempt is outside artifact order or retry bounds.`,
          );
        }
        pendingAttempt = attempt;
        expectedRetryAttempt = undefined;
        break;
      }
      case "replay.step.retry": {
        const retry = ReplayStepRetryEvidenceEventSchema.parse(event);
        if (
          !step ||
          !pendingAttempt ||
          retry.stepId !== step.id ||
          retry.stepId !== pendingAttempt.stepId ||
          retry.attempt !== pendingAttempt.attempt ||
          !step.retry.retryOn.includes(retry.retryKind) ||
          retry.attempt >= step.retry.maxAttempts
        ) {
          throw new Error(`Replay ${runId} retry is not bound to an eligible artifact attempt.`);
        }
        pendingAttempt = undefined;
        expectedRetryAttempt = retry.attempt + 1;
        break;
      }
      case "replay.step.completed": {
        const completed = ReplayStepCompletedEvidenceEventSchema.parse(event);
        if (
          !step ||
          !pendingAttempt ||
          completed.stepId !== step.id ||
          completed.stepId !== pendingAttempt.stepId ||
          completed.command !== step.command ||
          completed.command !== pendingAttempt.command ||
          completed.attempt !== pendingAttempt.attempt
        ) {
          throw new Error(`Replay ${runId} step completion lacks its matching artifact attempt.`);
        }
        pendingAttempt = undefined;
        expectedRetryAttempt = undefined;
        stepIndex += 1;
        break;
      }
      case "replay.intervention.resumed": {
        const resumed = ReplayResumedEvidenceEventSchema.parse(event);
        if (!step || !pendingAttempt || resumed.stepId !== step.id) {
          throw new Error(`Replay ${runId} resume is not bound to the interrupted artifact step.`);
        }
        resumedInterventions += 1;
        pendingAttempt = undefined;
        expectedRetryAttempt = undefined;
        break;
      }
      case "operator.audit":
        break;
      case "replay.surface.recovered":
        if (!pendingAttempt) {
          throw new Error(`Replay ${runId} recovery is not bound to an active artifact attempt.`);
        }
        break;
      default:
        throw new Error(`Replay ${runId} contains an invalid event in its executable lifecycle.`);
    }
  }

  if (
    (result.status === "succeeded" &&
      (stepIndex !== artifact.steps.length ||
        pendingAttempt ||
        expectedRetryAttempt !== undefined)) ||
    resumedInterventions > 1
  ) {
    throw new Error(`Replay ${runId} event flow does not prove the declared terminal result.`);
  }
  if (result.status === "business_outcome") {
    const predicateMatched = result.outcome.details.predicateMatched;
    const terminalStepId = result.outcome.details.stepId;
    const terminalCheckpoint = result.outcome.details.checkpoint;
    const pendingStepOutcome =
      pendingAttempt !== undefined &&
      stepIndex < artifact.steps.length &&
      terminalStepId === pendingAttempt.stepId &&
      terminalStepId === artifact.steps[stepIndex]?.id;
    const completedFlowOutcome =
      pendingAttempt === undefined &&
      expectedRetryAttempt === undefined &&
      stepIndex === artifact.steps.length &&
      terminalStepId === undefined &&
      terminalCheckpoint === "terminal";
    if (predicateMatched !== true || (!pendingStepOutcome && !completedFlowOutcome)) {
      throw new Error(
        `Replay ${runId} business outcome lacks a pending step or full terminal-checkpoint proof.`,
      );
    }
  }
}

function assertReplayArtifactBinding(
  runId: string,
  result: z.infer<typeof RunResultSchema>,
  artifact: z.infer<typeof CapabilityArtifactSchema>,
  artifactApproval: z.infer<typeof ArtifactApprovalSchema>,
  artifactApprovalDigest: string,
  eventLog: EventLogValidation,
): void {
  if (result.meta.artifactId !== artifact.id || result.meta.artifactDigest !== artifact.digest) {
    throw new Error(`Replay ${runId} result is not bound to the root artifact identity.`);
  }

  let started: z.infer<typeof ReplayStartedEvidenceEventSchema>;
  try {
    started = ReplayStartedEvidenceEventSchema.parse(eventLog.events[0]);
  } catch {
    throw new Error(`Replay ${runId} start event lacks its artifact/session identity binding.`);
  }
  if (
    started.artifactId !== artifact.id ||
    started.artifactDigest !== artifact.digest ||
    started.artifactApprovalMode !== "strict" ||
    started.artifactApprovalDigest !== artifactApprovalDigest ||
    started.sessionId !== result.meta.sessionId
  ) {
    throw new Error(`Replay ${runId} start event is inconsistent with its result and artifact.`);
  }
  try {
    assertArtifactApproval(artifact, artifactApproval, new Date(started.timestamp));
  } catch {
    throw new Error(`Replay ${runId} started outside the artifact approval validity window.`);
  }
  if (
    eventLog.events.some(
      (event) =>
        (event.sessionId !== undefined && event.sessionId !== result.meta.sessionId) ||
        (event.artifactId !== undefined && event.artifactId !== artifact.id) ||
        (event.artifactDigest !== undefined && event.artifactDigest !== artifact.digest),
    )
  ) {
    throw new Error(`Replay ${runId} events contain a conflicting session or artifact identity.`);
  }

  let completed: z.infer<typeof ReplayCompletedEvidenceEventSchema>;
  try {
    completed = ReplayCompletedEvidenceEventSchema.parse(eventLog.events.at(-1));
  } catch {
    throw new Error(`Replay ${runId} terminal event violates the replay evidence contract.`);
  }
  if (completed.status !== result.status || completed.durationMs !== result.meta.durationMs) {
    throw new Error(`Replay ${runId} terminal status is inconsistent with its result.`);
  }
  const startedAt = Date.parse(result.meta.startedAt);
  const finishedAt = Date.parse(result.meta.finishedAt);
  const startedEventAt = Date.parse(started.timestamp);
  const completedEventAt = Date.parse(completed.timestamp);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt < startedAt ||
    finishedAt - startedAt !== result.meta.durationMs ||
    startedEventAt < startedAt ||
    startedEventAt > finishedAt ||
    completedEventAt !== finishedAt
  ) {
    throw new Error(`Replay ${runId} duration does not match its lifecycle timestamps.`);
  }
}

function requiredCaptureDetail(
  runId: string,
  event: z.infer<typeof OperatorAuditEvidenceEventSchema>,
  key: "captureId" | "sha256" | "byteLength",
): string | number {
  const value = event.details[key];
  if (
    (key === "byteLength" && (!Number.isSafeInteger(value) || Number(value) <= 0)) ||
    (key !== "byteLength" && (typeof value !== "string" || !value))
  ) {
    throw new Error(`Replay ${runId} capture audit is missing a valid ${key}.`);
  }
  return key === "byteLength" ? Number(value) : String(value);
}

function requiredOperatorDetail<T>(
  runId: string,
  event: z.infer<typeof OperatorAuditEvidenceEventSchema>,
  key: string,
  schema: z.ZodType<T>,
): T {
  const parsed = schema.safeParse(event.details[key]);
  if (!parsed.success) {
    throw new Error(`Replay ${runId} operator audit is missing a safe ${key} detail.`);
  }
  return parsed.data;
}

function assertExactOperatorDetails(
  runId: string,
  event: z.infer<typeof OperatorAuditEvidenceEventSchema>,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(event.details).sort((left, right) => left.localeCompare(right));
  const expected = [...expectedKeys].sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Replay ${runId} operator audit contains unexpected or missing safe details.`);
  }
}

function assertHandoffBinding(
  runId: string,
  result: z.infer<typeof RunResultSchema>,
  handoff: z.infer<typeof HandoffEvidenceSummarySchema>,
  eventLog: EventLogValidation,
): void {
  if (handoff.interventionId !== `handoff-${runId}`) {
    throw new Error(`Replay ${runId} handoff intervention identity is inconsistent.`);
  }
  if (
    result.meta.sessionId !== handoff.originalSessionId ||
    result.meta.sessionId !== handoff.resumedSessionId
  ) {
    throw new Error(`Replay ${runId} handoff session identity is inconsistent.`);
  }

  let operatorEvents: z.infer<typeof OperatorAuditEvidenceEventSchema>[];
  try {
    operatorEvents = eventLog.events
      .filter((event) => event.type === "operator.audit")
      .map((event) => OperatorAuditEvidenceEventSchema.parse(event));
  } catch {
    throw new Error(`Replay ${runId} operator audit events violate the handoff contract.`);
  }
  if (
    operatorEvents.length !== handoff.operatorAuditEvents ||
    operatorEvents.some((event) => event.sessionId !== result.meta.sessionId)
  ) {
    throw new Error(`Replay ${runId} operator audit count or session binding is inconsistent.`);
  }

  const actions = operatorEvents.map((event) => event.action);
  const paused = operatorEvents.filter((event) => event.action === "automation_paused");
  const claimAuthorized = operatorEvents.filter(
    (event) => event.action === "control_claim_authorized",
  );
  const claimed = operatorEvents.filter((event) => event.action === "control_claimed");
  const returnAuthorized = operatorEvents.filter(
    (event) => event.action === "return_control_authorized",
  );
  const returned = operatorEvents.filter((event) => event.action === "control_returned");
  if (
    paused.length !== 1 ||
    claimAuthorized.length !== 1 ||
    claimed.length !== 1 ||
    returnAuthorized.length !== 1 ||
    returned.length !== 1 ||
    actions[0] !== "automation_paused" ||
    actions[1] !== "control_claim_authorized" ||
    actions[2] !== "control_claimed" ||
    actions.at(-2) !== "return_control_authorized" ||
    actions.at(-1) !== "control_returned" ||
    actions.includes("resume_checkpoint_failed") ||
    actions.includes("audit_sink_failed")
  ) {
    throw new Error(`Replay ${runId} operator audit does not prove a clean handoff lifecycle.`);
  }

  const pausedEvent = paused[0];
  const claimAuthorizedEvent = claimAuthorized[0];
  const claimedEvent = claimed[0];
  const returnAuthorizedEvent = returnAuthorized[0];
  const returnedEvent = returned[0];
  if (
    !pausedEvent ||
    !claimAuthorizedEvent ||
    !claimedEvent ||
    !returnAuthorizedEvent ||
    !returnedEvent
  ) {
    throw new Error(`Replay ${runId} operator audit lifecycle disappeared during validation.`);
  }
  if (
    pausedEvent.actor !== "automation" ||
    pausedEvent.actorId !== runId ||
    pausedEvent.ownerEpoch !== handoff.automationEpochBefore + 1 ||
    claimAuthorizedEvent.actor !== "operator" ||
    claimAuthorizedEvent.ownerEpoch !== pausedEvent.ownerEpoch ||
    claimAuthorizedEvent.details.expectedEpoch !== pausedEvent.ownerEpoch ||
    claimedEvent.actor !== "operator" ||
    claimedEvent.ownerEpoch !== handoff.operatorEpoch ||
    claimAuthorizedEvent.actorId !== claimedEvent.actorId ||
    handoff.operatorEpoch !== pausedEvent.ownerEpoch + 1 ||
    returnAuthorizedEvent.actor !== "operator" ||
    returnAuthorizedEvent.ownerEpoch !== handoff.operatorEpoch ||
    returnAuthorizedEvent.actorId !== claimedEvent.actorId ||
    returnAuthorizedEvent.details.checkpointPassed !== true ||
    returnedEvent.actor !== "system" ||
    returnedEvent.actorId !== "operator-console" ||
    returnedEvent.ownerEpoch !== handoff.automationEpochAfter ||
    handoff.automationEpochAfter !== handoff.operatorEpoch + 1 ||
    result.meta.ownerEpoch !== handoff.automationEpochAfter + 1
  ) {
    throw new Error(`Replay ${runId} operator audit epochs or actors are inconsistent.`);
  }
  if (
    operatorEvents.some(
      (event) =>
        [
          "operator_action_authorized",
          "operator_clicked",
          "operator_typed",
          "operator_pressed_key",
          "evidence_captured",
        ].includes(event.action) &&
        (event.actor !== "operator" || event.ownerEpoch !== handoff.operatorEpoch),
    )
  ) {
    throw new Error(`Replay ${runId} operator action authority is inconsistent.`);
  }

  const completedActionToPolicyAction = new Map([
    ["operator_clicked", "activate_coordinate"],
    ["operator_typed", "type"],
    ["operator_pressed_key", "press_key"],
    ["evidence_captured", "capture_evidence"],
  ]);
  const authorizedActionEvents = operatorEvents.filter(
    (event) => event.action === "operator_action_authorized",
  );
  const completedActionEvents = operatorEvents.filter((event) =>
    completedActionToPolicyAction.has(event.action),
  );
  if (authorizedActionEvents.length !== completedActionEvents.length) {
    throw new Error(`Replay ${runId} operator actions lack one-to-one pre-dispatch authorization.`);
  }
  for (const completed of completedActionEvents) {
    const completedIndex = operatorEvents.indexOf(completed);
    const authorization = operatorEvents[completedIndex - 1];
    if (authorization?.action !== "operator_action_authorized") {
      throw new Error(`Replay ${runId} operator action lacks its matching authorization event.`);
    }
    const expectedAction = completedActionToPolicyAction.get(completed.action);
    const action = requiredOperatorDetail(runId, authorization, "action", IdentifierSchema);
    const authorizedEffect = requiredOperatorDetail(
      runId,
      authorization,
      "effect",
      EffectClassSchema,
    );
    const completedEffect = requiredOperatorDetail(runId, completed, "effect", EffectClassSchema);
    const authorizedGrant = requiredOperatorDetail(
      runId,
      authorization,
      "policyGrantMode",
      IdentifierSchema,
    );
    const completedGrant = requiredOperatorDetail(
      runId,
      completed,
      "policyGrantMode",
      IdentifierSchema,
    );
    if (
      action !== expectedAction ||
      authorization.actorId !== claimedEvent.actorId ||
      completed.actorId !== claimedEvent.actorId ||
      authorizedEffect !== completedEffect ||
      authorizedGrant !== completedGrant
    ) {
      throw new Error(
        `Replay ${runId} operator completion is not bound to its action, effect, and policy grant.`,
      );
    }

    switch (completed.action) {
      case "operator_clicked": {
        assertExactOperatorDetails(runId, authorization, [
          "action",
          "effect",
          "policyGrantMode",
          "x",
          "y",
        ]);
        assertExactOperatorDetails(runId, completed, ["effect", "policyGrantMode", "x", "y"]);
        const coordinate = z.number().int().min(0);
        const authorizedX = requiredOperatorDetail(runId, authorization, "x", coordinate);
        const authorizedY = requiredOperatorDetail(runId, authorization, "y", coordinate);
        if (
          authorizedEffect !== "commit" ||
          authorizedX !== requiredOperatorDetail(runId, completed, "x", coordinate) ||
          authorizedY !== requiredOperatorDetail(runId, completed, "y", coordinate)
        ) {
          throw new Error(`Replay ${runId} operator click details do not match authorization.`);
        }
        break;
      }
      case "operator_typed": {
        assertExactOperatorDetails(runId, authorization, [
          "action",
          "effect",
          "policyGrantMode",
          "characterCount",
        ]);
        assertExactOperatorDetails(runId, completed, [
          "effect",
          "policyGrantMode",
          "characterCount",
        ]);
        const characterCount = z.number().int().min(1).max(4_096);
        if (
          // Generic typing can synchronously submit or autosave, so the
          // operator runtime intentionally classifies it as a commit.
          authorizedEffect !== "commit" ||
          requiredOperatorDetail(runId, authorization, "characterCount", characterCount) !==
            requiredOperatorDetail(runId, completed, "characterCount", characterCount)
        ) {
          throw new Error(`Replay ${runId} operator type details do not match authorization.`);
        }
        break;
      }
      case "operator_pressed_key": {
        assertExactOperatorDetails(runId, authorization, [
          "action",
          "effect",
          "policyGrantMode",
          "key",
        ]);
        assertExactOperatorDetails(runId, completed, ["effect", "policyGrantMode", "key"]);
        const safeKey = z.enum([
          "Enter",
          "Escape",
          "Tab",
          "Shift+Tab",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Backspace",
          "Delete",
          "Home",
          "End",
          "PageUp",
          "PageDown",
          "Space",
        ]);
        const authorizedKey = requiredOperatorDetail(runId, authorization, "key", safeKey);
        const expectedEffect =
          authorizedKey === "Enter" || authorizedKey === "Space"
            ? "commit"
            : authorizedKey === "Tab" || authorizedKey === "Shift+Tab"
              ? "read"
              : "reversible_write";
        if (
          authorizedEffect !== expectedEffect ||
          authorizedKey !== requiredOperatorDetail(runId, completed, "key", safeKey)
        ) {
          throw new Error(`Replay ${runId} operator key details do not match authorization.`);
        }
        break;
      }
      case "evidence_captured":
        assertExactOperatorDetails(runId, authorization, ["action", "effect", "policyGrantMode"]);
        assertExactOperatorDetails(runId, completed, [
          "effect",
          "policyGrantMode",
          "captureId",
          "sha256",
          "byteLength",
        ]);
        if (authorizedEffect !== "read") {
          throw new Error(`Replay ${runId} evidence capture effect is not read-only.`);
        }
        break;
    }
  }

  const captureEvents = operatorEvents.filter((event) => event.action === "evidence_captured");
  if (captureEvents.length !== handoff.evidence.length) {
    throw new Error(`Replay ${runId} handoff capture count is inconsistent.`);
  }
  const captureIds = new Set<string>();
  const capturesWithPositions: Array<{ readonly index: number; readonly sha256: string }> = [];
  const evidencePaths = new Set<string>();
  for (const event of captureEvents) {
    const captureId = requiredCaptureDetail(runId, event, "captureId") as string;
    const captureSha256 = requiredCaptureDetail(runId, event, "sha256") as string;
    const captureByteLength = requiredCaptureDetail(runId, event, "byteLength") as number;
    const expectedPath = `screenshots/${captureId}.png`;
    const evidence = handoff.evidence.find((ref) => ref.relativePath === expectedPath);
    if (
      captureIds.has(captureId) ||
      !evidence ||
      evidence.sha256 !== captureSha256 ||
      evidence.byteLength !== captureByteLength ||
      evidence.mimeType !== "image/png"
    ) {
      throw new Error(`Replay ${runId} handoff capture audit is not bound to screenshot evidence.`);
    }
    captureIds.add(captureId);
    capturesWithPositions.push({ index: operatorEvents.indexOf(event), sha256: captureSha256 });
    evidencePaths.add(evidence.relativePath);
  }
  if (evidencePaths.size !== handoff.evidence.length) {
    throw new Error(`Replay ${runId} handoff screenshot evidence is not uniquely audit-bound.`);
  }
  const hasDistinctBracketedRecoveryEvidence = operatorEvents.some((event, clickIndex) => {
    if (event.action !== "operator_clicked") return false;
    const before = capturesWithPositions.filter((capture) => capture.index < clickIndex);
    const after = capturesWithPositions.filter((capture) => capture.index > clickIndex);
    return before.some((earlier) => after.some((later) => earlier.sha256 !== later.sha256));
  });
  if (captureEvents.length < 2 || !hasDistinctBracketedRecoveryEvidence) {
    throw new Error(
      `Replay ${runId} must prove distinct before/after captures around an authorized recovery click.`,
    );
  }

  let resumedEvents: z.infer<typeof ReplayResumedEvidenceEventSchema>[];
  try {
    resumedEvents = eventLog.events
      .filter((event) => event.type === "replay.intervention.resumed")
      .map((event) => ReplayResumedEvidenceEventSchema.parse(event));
  } catch {
    throw new Error(`Replay ${runId} resume event violates the handoff contract.`);
  }
  const resumed = resumedEvents[0];
  const interruptedAttemptEvents = eventLog.events
    .filter(
      (event) =>
        event.type === "replay.step.attempt" &&
        (operatorEvents[0] === undefined || event.sequence < operatorEvents[0].sequence),
    )
    .map((event) => ReplayStepAttemptEvidenceEventSchema.parse(event));
  const interruptedAttempt = interruptedAttemptEvents.at(-1);
  const operatorBlockIsContiguous = operatorEvents.every(
    (event, index) =>
      index === 0 || event.sequence === (operatorEvents[index - 1]?.sequence ?? -1) + 1,
  );
  const freshObservationId = requiredOperatorDetail(
    runId,
    returnedEvent,
    "freshObservationId",
    IdentifierSchema,
  );
  assertExactOperatorDetails(runId, returnedEvent, ["freshObservationId", "checkpointPassed"]);
  if (
    resumedEvents.length !== 1 ||
    !resumed ||
    !interruptedAttempt ||
    resumed.sessionId !== result.meta.sessionId ||
    resumed.priorOwnerEpoch !== handoff.automationEpochBefore ||
    resumed.newOwnerEpoch !== handoff.automationEpochAfter ||
    resumed.stepId !== interruptedAttempt.stepId ||
    freshObservationId !== resumed.observationId ||
    !operatorBlockIsContiguous ||
    operatorEvents[0]?.sequence !== interruptedAttempt.sequence + 1 ||
    returnedEvent.sequence !== operatorEvents.at(-1)?.sequence ||
    resumed.sequence !== returnedEvent.sequence + 1
  ) {
    throw new Error(
      `Replay ${runId} handoff audit block is not bound to its pending step and resume observation.`,
    );
  }
}

function uniqueScreenshotMap(
  runId: string,
  source: string,
  refs: readonly ScreenshotEvidenceRef[],
): Map<string, ScreenshotEvidenceRef> {
  const result = new Map<string, ScreenshotEvidenceRef>();
  for (const ref of refs) {
    if (result.has(ref.relativePath)) {
      throw new Error(`Run ${runId} ${source} contains duplicate screenshot refs.`);
    }
    result.set(ref.relativePath, ref);
  }
  return result;
}

async function validateRunScreenshots(
  root: string,
  run: ManifestRun,
  summaryRefs: readonly z.infer<typeof EvidenceRefSchema>[],
): Promise<readonly string[]> {
  if (
    summaryRefs.some(
      (ref) => ref.kind === "screenshot" && ref.id !== `ev_${ref.sha256.slice(0, 24)}`,
    )
  ) {
    throw new Error(`Run ${run.id} screenshot evidence IDs must be content-addressed.`);
  }
  const manifestRefs = uniqueScreenshotMap(run.id, "manifest", run.screenshots);
  const projectedSummaryRefs = uniqueScreenshotMap(
    run.id,
    "summary",
    summaryScreenshotRefs(run, summaryRefs),
  );
  if (manifestRefs.size !== projectedSummaryRefs.size) {
    throw new Error(`Run ${run.id} manifest and summary screenshot refs do not match.`);
  }

  const expectedDirectory = `${run.directory}/screenshots`;
  for (const [relativePath, ref] of manifestRefs) {
    const summaryRef = projectedSummaryRefs.get(relativePath);
    if (
      !summaryRef ||
      summaryRef.sha256 !== ref.sha256 ||
      summaryRef.byteLength !== ref.byteLength ||
      summaryRef.mimeType !== ref.mimeType
    ) {
      throw new Error(`Run ${run.id} manifest and summary screenshot refs do not match.`);
    }
    if (
      path.posix.dirname(relativePath) !== expectedDirectory ||
      path.posix.extname(relativePath) !== ".png"
    ) {
      throw new Error(
        `Run ${run.id} screenshot refs must be PNG files inside its screenshots directory.`,
      );
    }

    const bytes = await requireRegularFile(
      inside(root, relativePath),
      `Run ${run.id} screenshot ${path.posix.basename(relativePath)}`,
    );
    if (bytes.byteLength !== ref.byteLength) {
      throw new Error(`Run ${run.id} screenshot byteLength does not match its ref.`);
    }
    if (sha256(bytes) !== ref.sha256) {
      throw new Error(`Run ${run.id} screenshot SHA-256 does not match its ref.`);
    }
    assertValidPng(bytes, `Run ${run.id} screenshot`);
  }
  return [...manifestRefs.keys()];
}

function withoutRedactionMarkers(value: string): string {
  return value
    .replaceAll(SECRET_REDACTION, "")
    .replaceAll(PII_REDACTION, "")
    .replaceAll(INTERNAL_REDACTION, "");
}

const SHA256_FIELD_NAMES = new Set([
  "artifactApprovalDigest",
  "artifactApprovalSha256",
  "artifactDigest",
  "artifactSha256",
  "baseTargetDigest",
  "digest",
  "eventsSha256",
  "overrideTargetDigest",
  "promptHash",
  "sha256",
  "sourceTreeSha256",
  "summarySha256",
  "surfaceFingerprint",
  "targetFixtureSha256",
]);

function isSchemaValidatedDigest(field: string | undefined, value: string): boolean {
  if (field === "sourceRevision") return /^[a-f0-9]{40}$/u.test(value);
  return field !== undefined && SHA256_FIELD_NAMES.has(field) && /^[a-f0-9]{64}$/u.test(value);
}

function structuredStringValues(value: unknown, strings: string[], field?: string): void {
  if (typeof value === "string") {
    if (!isSchemaValidatedDigest(field, value)) strings.push(value);
    return;
  }
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) >= 1_000_000_000_000
  ) {
    strings.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) structuredStringValues(item, strings, field);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) structuredStringValues(item, strings, key);
  }
}

function aggregateSensitivePatterns(values: readonly string[]): SensitivePatternFinding[] {
  const totals = new Map<string, SensitivePatternFinding>();
  for (const value of values) {
    for (const finding of findSensitivePatterns(withoutRedactionMarkers(value))) {
      const key = `${finding.kind}:${finding.pattern}`;
      const current = totals.get(key);
      totals.set(key, {
        kind: finding.kind,
        pattern: finding.pattern,
        count: (current?.count ?? 0) + finding.count,
      });
    }
  }
  return [...totals.values()];
}

/**
 * Scan human-authored text as a document, but scan JSON evidence by string value.
 * Decimal JSON fields are typed geometry rather than human text, and strict hash fields
 * are schema-validated digests rather than content. Treating either as a payment-card
 * candidate creates a cross-type false positive. Large safe integers and hash-shaped
 * strings outside the exact digest fields remain scanned and fail closed.
 */
export function findSensitiveEvidencePatterns(
  relativePath: string,
  text: string,
): SensitivePatternFinding[] {
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (extension !== ".json" && extension !== ".jsonl") {
    return findSensitivePatterns(withoutRedactionMarkers(text));
  }

  const documents =
    extension === ".json"
      ? [JSON.parse(text) as unknown]
      : text
          .split(/\r?\n/u)
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as unknown);
  const strings: string[] = [];
  for (const document of documents) structuredStringValues(document, strings);
  return aggregateSensitivePatterns(strings);
}

async function validateNoSensitiveText(root: string, files: readonly string[]): Promise<void> {
  for (const relative of files) {
    if (FORBIDDEN_FILE.test(relative)) {
      throw new Error(`Forbidden raw evidence file ${relative}.`);
    }
    if (!TEXT_FILE.test(relative)) continue;
    const text = await readFile(inside(root, relative), "utf8");
    const findings = findSensitiveEvidencePatterns(relative, text);
    if (findings.length > 0) {
      throw new Error(
        `Sensitive text pattern detected in ${relative}: ${findings.map((item) => item.pattern).join(", ")}.`,
      );
    }
  }
}

export async function validateEvidenceBundle(
  rootDirectory: string,
  options: EvidenceValidationOptions = {},
): Promise<EvidenceValidationReport> {
  const root = path.resolve(rootDirectory);
  await requireDirectory(root, "Evidence root");
  await requireDirectory(path.join(root, "artifacts"), "Evidence artifacts directory");
  await requireDirectory(path.join(root, "runs"), "Evidence runs directory");
  await requireRegularFile(path.join(root, "README.md"), "Evidence README");
  const files = await walk(root);
  const unsupportedFiles = files.filter((relative) => !ALLOWED_BUNDLE_FILE.test(relative));
  if (unsupportedFiles.length > 0) {
    throw new Error(`Evidence contains unsupported file type ${unsupportedFiles[0]}.`);
  }

  const manifest = EvidenceManifestSchema.parse(
    await jsonFile(path.join(root, "manifest.json"), "Evidence manifest"),
  );
  const expectedSourceTree = await treeSha256(path.join(PROJECT_ROOT, "src"));
  const expectedTargetFixture = await treeSha256(path.join(PROJECT_ROOT, "src", "target"));
  if (
    manifest.provenance.sourceTreeSha256 !== expectedSourceTree ||
    manifest.provenance.targetFixtureSha256 !== expectedTargetFixture
  ) {
    throw new Error("Evidence runtime provenance does not match the checked-out source tree.");
  }
  if (manifest.provenance.sourceRevision !== "working-tree") {
    const committedSourceTree = await sourceTreeSha256AtRevision(
      PROJECT_ROOT,
      manifest.provenance.sourceRevision,
    );
    if (committedSourceTree !== manifest.provenance.sourceTreeSha256) {
      throw new Error(
        "Evidence source revision does not contain the source tree recorded by the manifest.",
      );
    }
  }
  const playwrightManifest = (await jsonFile(
    path.join(PROJECT_ROOT, "node_modules", "playwright", "package.json"),
    "Installed Playwright manifest",
  )) as { readonly version?: unknown };
  if (playwrightManifest.version !== manifest.provenance.playwrightVersion) {
    throw new Error("Evidence Playwright provenance does not match the installed runtime.");
  }
  if (
    manifest.provenance.invocation.planner !== manifest.mode ||
    manifest.provenance.invocation.command !==
      (manifest.mode === "live" ? "demo:live" : "demo:offline")
  ) {
    throw new Error("Evidence invocation provenance is inconsistent with manifest mode.");
  }
  if (
    manifest.provenance.invocation.syntheticTarget !==
    (manifest.provenance.invocation.targetSource === "bundled-fixture")
  ) {
    throw new Error("Evidence target source and synthetic-target provenance are inconsistent.");
  }
  if (manifest.mode !== "live" && options.allowScriptedDiscovery !== true) {
    throw new Error("Committed evidence manifest must identify a live discovery mode.");
  }
  if (
    options.allowScriptedDiscovery !== true &&
    (manifest.provenance.sourceRevision === "working-tree" ||
      manifest.provenance.invocation.screenshotModelInput ||
      manifest.provenance.invocation.targetSource !== "bundled-fixture" ||
      !manifest.provenance.invocation.syntheticTarget)
  ) {
    throw new Error(
      "Committed live evidence requires a revision-bound, semantic-only, synthetic-target invocation.",
    );
  }

  await validateHashes(root, manifest.artifact, manifest.artifactSha256, "Capability artifact");
  if (
    path.posix.dirname(manifest.artifact) !== "artifacts" ||
    !manifest.artifact.endsWith(".json") ||
    manifest.artifact.endsWith(".approval.json")
  ) {
    throw new Error("Capability artifact must use a canonical JSON path inside artifacts/.");
  }
  const artifact = CapabilityArtifactSchema.parse(
    await jsonFile(inside(root, manifest.artifact), "Capability artifact"),
  );
  if (!verifyArtifactDigest(artifact)) throw new Error("Capability artifact digest is invalid.");
  assertAssignmentOutputContract(artifact);
  const assignmentOutcomeCode = artifact.contract.outcomes[0]?.code;
  if (
    path.posix.dirname(manifest.artifactApproval) !== "artifacts" ||
    !manifest.artifactApproval.endsWith(".approval.json")
  ) {
    throw new Error("Artifact approval must use a canonical approval JSON path inside artifacts/.");
  }
  await validateHashes(
    root,
    manifest.artifactApproval,
    manifest.artifactApprovalSha256,
    "Artifact approval",
  );
  const artifactApproval = ArtifactApprovalSchema.parse(
    await jsonFile(inside(root, manifest.artifactApproval), "Artifact approval"),
  );
  assertArtifactApproval(artifact, artifactApproval, new Date(manifest.generatedAt));
  const artifactApprovalDigest = computeArtifactApprovalDigest(artifactApproval);
  if (artifact.provenance.liveModel !== true && options.allowScriptedDiscovery !== true) {
    throw new Error("Capability artifact provenance must record liveModel true.");
  }
  if (
    options.allowScriptedDiscovery !== true &&
    (manifest.model.provider !== "ollama-local" ||
      manifest.model.transport !== "native-ollama" ||
      artifact.provenance.provider !== "ollama-local" ||
      manifest.model.digest === undefined)
  ) {
    throw new Error(
      "Committed live evidence requires a SHA-256-bound native local Ollama model identity.",
    );
  }
  if (
    manifest.model.provider !== artifact.provenance.provider ||
    manifest.model.modelId !== artifact.provenance.modelId ||
    manifest.model.liveModel !== artifact.provenance.liveModel
  ) {
    throw new Error("Manifest model identity must match capability provenance.");
  }

  await validateHashes(
    root,
    manifest.stability.path,
    manifest.stability.sha256,
    "Replay stability report",
  );
  if (manifest.stability.path !== "stability.json") {
    throw new Error("Replay stability evidence must use the canonical stability.json path.");
  }
  const stability = StabilitySchema.parse(
    await jsonFile(inside(root, manifest.stability.path), "Replay stability report"),
  );
  if (manifest.provenance.invocation.replayRuns !== stability.requestedRuns) {
    throw new Error("Evidence invocation replay count is inconsistent with stability evidence.");
  }
  if (
    stability.artifactId !== artifact.id ||
    stability.artifactDigest !== artifact.digest ||
    stability.completedRuns !== stability.runs.length ||
    stability.requestedRuns !== stability.runs.length
  ) {
    throw new Error("Replay stability report identity or counts are inconsistent.");
  }
  const succeeded = stability.runs.filter((run) => run.status === "succeeded").length;
  const expectedLatency = computedLatency(stability.runs);
  if (
    stability.succeeded !== succeeded ||
    stability.successRate !== Number((succeeded / stability.runs.length).toFixed(4)) ||
    !stability.allZeroModelCalls ||
    stability.totalModelCalls !== 0 ||
    stability.runs.some((run) => run.modelCalls !== 0)
  ) {
    throw new Error("Replay stability report must accurately prove zero-model deterministic runs.");
  }
  if (
    stability.latencyMs.min !== expectedLatency.min ||
    stability.latencyMs.max !== expectedLatency.max ||
    stability.latencyMs.mean !== expectedLatency.mean ||
    stability.latencyMs.p50 !== expectedLatency.p50 ||
    stability.latencyMs.p95 !== expectedLatency.p95
  ) {
    throw new Error("Replay stability latency statistics do not recompute from the run entries.");
  }

  const discoveryRuns = manifest.runs.filter((run) => run.kind === "discovery");
  const successReplays = manifest.runs.filter(
    (run) => run.kind === "replay" && run.scenario === "success",
  );
  const exceptionalReplays = manifest.runs.filter(
    (run) => run.kind === "replay" && run.scenario === "exception",
  );
  const handoffReplays = manifest.runs.filter(
    (run) => run.kind === "replay" && run.scenario === "handoff",
  );
  if (new Set(manifest.runs.map((run) => run.id)).size !== manifest.runs.length) {
    throw new Error("Manifest run IDs must be unique.");
  }
  if (discoveryRuns.length !== 1)
    throw new Error("Manifest must contain exactly one discovery run.");
  if (successReplays.length < 1) throw new Error("Manifest must contain a successful replay run.");
  if (exceptionalReplays.length < 1) {
    throw new Error("Manifest must contain an exceptional replay run.");
  }
  if (options.allowScriptedDiscovery !== true && handoffReplays.length < 1) {
    throw new Error("Committed live evidence must contain a same-session handoff replay run.");
  }
  const stabilityRunIds = new Set(stability.runs.map((run) => run.runId));
  const successfulReplayIds = new Set(successReplays.map((run) => run.id));
  if (
    stabilityRunIds.size !== stability.runs.length ||
    stabilityRunIds.size !== successfulReplayIds.size ||
    [...stabilityRunIds].some((runId) => !successfulReplayIds.has(runId))
  ) {
    throw new Error("Replay stability runs must exactly match successful replay entries.");
  }
  if (
    options.allowScriptedDiscovery !== true &&
    (stability.requestedRuns < 10 ||
      stability.succeeded !== stability.requestedRuns ||
      stability.successRate !== 1 ||
      stability.runs.some((run) => run.status !== "succeeded"))
  ) {
    throw new Error("Committed live evidence requires at least 10 clean successful replay runs.");
  }

  const referencedScreenshots = new Set<string>();
  const stabilityByRunId = new Map(stability.runs.map((entry) => [entry.runId, entry]));
  const successfulReplaySessions = new Map<string, string>();
  let discoverySessionId: string | undefined;
  const referencedFiles = new Set<string>([
    "README.md",
    "manifest.json",
    manifest.artifact,
    manifest.artifactApproval,
    manifest.stability.path,
  ]);
  for (const run of manifest.runs) {
    if (run.directory !== `runs/${run.id}`) {
      throw new Error(`Run ${run.id} directory must match its run identity.`);
    }
    if (
      run.summary !== `${run.directory}/summary.json` ||
      run.events !== `${run.directory}/events.redacted.jsonl`
    ) {
      throw new Error(`Run ${run.id} summary and events must use canonical structured filenames.`);
    }
    await requireDirectory(inside(root, run.directory), `Run directory ${run.id}`);
    if (
      !run.summary.startsWith(`${run.directory}/`) ||
      !run.events.startsWith(`${run.directory}/`)
    ) {
      throw new Error(`Run ${run.id} files must remain inside its declared directory.`);
    }
    await validateHashes(root, run.summary, run.summarySha256, `Run ${run.id} summary`);
    await validateHashes(root, run.events, run.eventsSha256, `Run ${run.id} events`);
    referencedFiles.add(run.summary);
    referencedFiles.add(run.events);
    const eventLog = await validateJsonLines(
      inside(root, run.events),
      `Run ${run.id} events`,
      run.id,
      run.kind,
    );

    const screenshotDirectory = path.join(inside(root, run.directory), "screenshots");
    await requireDirectory(screenshotDirectory, `Run ${run.id} screenshots`);

    const summary = await jsonFile(inside(root, run.summary), `Run ${run.id} summary`);
    if (run.kind === "discovery") {
      const parsed = DiscoverySummarySchema.parse(summary);
      const expectedRunArtifact = `${run.directory}/artifact.json`;
      if (
        run.artifact !== expectedRunArtifact ||
        run.artifactSha256 === undefined ||
        run.artifactSha256 !== manifest.artifactSha256
      ) {
        throw new Error("Discovery run artifact is not hash-bound to the root artifact.");
      }
      await validateHashes(root, run.artifact, run.artifactSha256, "Discovery run artifact");
      referencedFiles.add(run.artifact);
      const discoveryArtifactBytes = await requireRegularFile(
        inside(root, run.artifact),
        "Discovery run artifact",
      );
      const rootArtifactBytes = await requireRegularFile(
        inside(root, manifest.artifact),
        "Capability artifact",
      );
      if (!discoveryArtifactBytes.equals(rootArtifactBytes)) {
        throw new Error("Discovery run artifact bytes do not exactly match the root artifact.");
      }
      const artifactRefs = parsed.evidence.filter((ref) => ref.kind === "artifact");
      const discoveryArtifactRef = artifactRefs[0];
      if (
        artifactRefs.length !== 1 ||
        !discoveryArtifactRef ||
        discoveryArtifactRef.relativePath !== "artifact.json" ||
        discoveryArtifactRef.sha256 !== run.artifactSha256 ||
        discoveryArtifactRef.byteLength !== discoveryArtifactBytes.byteLength ||
        discoveryArtifactRef.mimeType !== "application/json"
      ) {
        throw new Error("Discovery summary does not bind its exact generated artifact evidence.");
      }
      if (parsed.runId !== run.id || parsed.provenance.discoveryRunId !== run.id) {
        throw new Error("Discovery summary run identity is inconsistent.");
      }
      if (
        eventLog.modelDecisions !== parsed.modelCalls ||
        eventLog.terminalModelCalls !== parsed.modelCalls
      ) {
        throw new Error(
          "Discovery event log model-call evidence is inconsistent with its summary.",
        );
      }
      if (parsed.artifactDigest !== artifact.digest || parsed.artifactId !== artifact.id) {
        throw new Error("Discovery summary does not reference the root artifact.");
      }
      assertProjectedSuccessOutputs(run.id, parsed.outputs, artifact);
      if (
        parsed.provenance.provider !== artifact.provenance.provider ||
        parsed.provenance.modelId !== artifact.provenance.modelId ||
        parsed.provenance.promptHash !== artifact.provenance.promptHash ||
        parsed.provenance.liveModel !== artifact.provenance.liveModel
      ) {
        throw new Error("Discovery summary provenance must match the root artifact.");
      }
      if (parsed.provenance.liveModel !== true && options.allowScriptedDiscovery !== true) {
        throw new Error("Discovery summary provenance must record liveModel true.");
      }
      assertDiscoveryLifecycle(run.id, parsed, artifact, eventLog);
      const discoveryCompletedAt = Date.parse(eventLog.events.at(-1)?.timestamp ?? "");
      const artifactCreatedAt = Date.parse(artifact.provenance.createdAt);
      const approvalCreatedAt = Date.parse(artifactApproval.approvedAt);
      if (
        !Number.isFinite(discoveryCompletedAt) ||
        !Number.isFinite(artifactCreatedAt) ||
        !Number.isFinite(approvalCreatedAt) ||
        artifactCreatedAt > discoveryCompletedAt ||
        approvalCreatedAt < discoveryCompletedAt
      ) {
        throw new Error(
          "Artifact approval must be issued after the discovery artifact lifecycle completes.",
        );
      }
      discoverySessionId = parsed.sessionId;
      for (const screenshot of await validateRunScreenshots(root, run, parsed.evidence)) {
        if (referencedScreenshots.has(screenshot)) {
          throw new Error(`Screenshot ${screenshot} is referenced by more than one run.`);
        }
        referencedScreenshots.add(screenshot);
      }
    } else {
      const parsed = ReplaySummarySchema.parse(summary);
      if (eventLog.modelDecisions !== 0 || eventLog.terminalModelCalls !== 0) {
        throw new Error(`Replay ${run.id} event log does not prove zero model calls.`);
      }
      if (parsed.scenario !== run.scenario || parsed.result.meta.runId !== run.id) {
        throw new Error(`Replay summary identity is inconsistent for ${run.id}.`);
      }
      if (parsed.result.meta.modelCalls !== 0) {
        throw new Error(`Replay ${run.id} must record modelCalls 0.`);
      }
      assertReplayArtifactBinding(
        run.id,
        parsed.result,
        artifact,
        artifactApproval,
        artifactApprovalDigest,
        eventLog,
      );
      assertReplayLifecycle(run.id, parsed.result, artifact, eventLog);
      if (parsed.result.status === "succeeded") {
        assertProjectedSuccessOutputs(run.id, parsed.result.outputs, artifact);
      }
      if (run.scenario === "success" && parsed.result.status !== "succeeded") {
        throw new Error(`Replay ${run.id} is labeled success but did not succeed.`);
      }
      if (run.scenario === "success") {
        const stabilityEntry = stabilityByRunId.get(run.id);
        if (
          !stabilityEntry ||
          stabilityEntry.status !== parsed.result.status ||
          stabilityEntry.durationMs !== parsed.result.meta.durationMs ||
          stabilityEntry.modelCalls !== parsed.result.meta.modelCalls
        ) {
          throw new Error(`Replay ${run.id} summary metadata is not bound to its stability entry.`);
        }
        successfulReplaySessions.set(run.id, parsed.result.meta.sessionId);
      }
      if (
        run.scenario === "exception" &&
        (parsed.result.status !== "business_outcome" ||
          parsed.result.outcome.code !== assignmentOutcomeCode)
      ) {
        throw new Error(
          `Replay ${run.id} must prove the declared MEMBER_NOT_FOUND business outcome.`,
        );
      }
      if (run.scenario === "handoff") {
        if (parsed.result.status !== "succeeded" || !parsed.handoff) {
          throw new Error(`Replay ${run.id} is labeled handoff but did not resume successfully.`);
        }
        assertHandoffBinding(run.id, parsed.result, parsed.handoff, eventLog);
      } else if (
        eventLog.operatorAuditEvents !== 0 ||
        eventLog.events.some((event) => event.type === "replay.intervention.resumed")
      ) {
        throw new Error(`Replay ${run.id} unexpectedly contains handoff-only events.`);
      }
      for (const screenshot of await validateRunScreenshots(root, run, [
        ...replayEvidenceRefs(parsed.result),
        ...(parsed.handoff?.evidence ?? []),
      ])) {
        if (referencedScreenshots.has(screenshot)) {
          throw new Error(`Screenshot ${screenshot} is referenced by more than one run.`);
        }
        referencedScreenshots.add(screenshot);
        referencedFiles.add(screenshot);
      }
    }
  }

  const sessionIds = [...successfulReplaySessions.values()];
  if (
    sessionIds.length !== successReplays.length ||
    new Set(sessionIds).size !== sessionIds.length ||
    (discoverySessionId !== undefined && sessionIds.includes(discoverySessionId))
  ) {
    throw new Error("Replay stability runs must each prove a unique fresh surface session.");
  }

  for (const screenshot of referencedScreenshots) referencedFiles.add(screenshot);

  const pngFiles: string[] = [];
  for (const relative of files) {
    const hasPngExtension = path.posix.extname(relative).toLowerCase() === ".png";
    const bytes = await requireRegularFile(inside(root, relative), `Evidence file ${relative}`);
    const hasPngSignature = bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE);
    if (hasPngExtension || hasPngSignature) pngFiles.push(relative);
  }
  const unreferencedPngs = pngFiles.filter((relative) => !referencedScreenshots.has(relative));
  if (unreferencedPngs.length > 0 || pngFiles.length !== referencedScreenshots.size) {
    throw new Error(
      `Evidence contains unreferenced PNG screenshot${unreferencedPngs.length === 1 ? "" : "s"}: ${unreferencedPngs.join(", ") || "screenshot inventory mismatch"}.`,
    );
  }
  const unreferencedFiles = files.filter((relative) => !referencedFiles.has(relative));
  const missingFiles = [...referencedFiles].filter((relative) => !files.includes(relative));
  if (unreferencedFiles.length > 0 || missingFiles.length > 0) {
    throw new Error(
      `Evidence file inventory is not exact: unreferenced=${unreferencedFiles.join(", ") || "none"}; missing=${missingFiles.join(", ") || "none"}.`,
    );
  }
  for (const relative of files.filter((name) => name.endsWith(".json"))) {
    await jsonFile(inside(root, relative), `JSON file ${relative}`);
  }
  await validateNoSensitiveText(root, files);

  const discovery = discoveryRuns[0];
  if (!discovery) throw new Error("Discovery run disappeared during validation.");
  return {
    root,
    files: files.length,
    runs: manifest.runs.length,
    discoveryRunId: discovery.id,
    replayRunIds: manifest.runs.filter((run) => run.kind === "replay").map((run) => run.id),
    artifactDigest: artifact.digest,
  };
}

function parseCli(argv: readonly string[]): { root: string; allowScriptedDiscovery: boolean } {
  let root = process.env.HANDRAIL_EVIDENCE_DIR ?? "evidence";
  let allowScriptedDiscovery = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--allow-scripted") {
      allowScriptedDiscovery = true;
      continue;
    }
    if (token === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a directory.");
      root = value;
      index += 1;
      continue;
    }
    if (token?.startsWith("--root=")) {
      root = token.slice("--root=".length);
      continue;
    }
    throw new Error(`Unknown evidence validator option ${token}.`);
  }
  return { root: path.resolve(process.cwd(), root), allowScriptedDiscovery };
}

async function main(): Promise<void> {
  try {
    const parsed = parseCli(process.argv.slice(2));
    const report = await validateEvidenceBundle(parsed.root, {
      allowScriptedDiscovery: parsed.allowScriptedDiscovery,
    });
    process.stdout.write(`${JSON.stringify({ status: "valid", ...report }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `Evidence validation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
