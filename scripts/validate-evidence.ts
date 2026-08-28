import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { z } from "zod";
import {
  CapabilityArtifactSchema,
  EvidenceRefSchema,
  IdentifierSchema,
  RunResultSchema,
  Sha256Schema,
} from "../src/domain/schema.js";
import { verifyArtifactDigest } from "../src/runtime/artifact.js";
import { findSensitivePatterns } from "../src/runtime/redaction.js";

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
    scenario: z.enum(["success", "exception"]),
    directory: RelativePathSchema,
    summary: RelativePathSchema,
    summarySha256: Sha256Schema,
    events: RelativePathSchema,
    eventsSha256: Sha256Schema,
    screenshots: z.array(ScreenshotEvidenceRefSchema).min(1).max(100),
  })
  .strict();

const EvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal("1.1.0"),
    generatedAt: z.iso.datetime({ offset: true }),
    mode: z.enum(["scripted", "live"]),
    model: z
      .object({
        provider: z.string().min(1).max(120),
        modelId: z.string().min(1).max(200),
        liveModel: z.boolean(),
        digest: z.string().min(8).max(256).optional(),
      })
      .strict(),
    artifact: RelativePathSchema,
    artifactSha256: Sha256Schema,
    stability: z.object({ path: RelativePathSchema, sha256: Sha256Schema }).strict(),
    runs: z.array(ManifestRunSchema).min(3).max(100),
  })
  .strict();

type ManifestRun = z.infer<typeof ManifestRunSchema>;
type ScreenshotEvidenceRef = z.infer<typeof ScreenshotEvidenceRefSchema>;

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
  .passthrough();

const ReplaySummarySchema = z
  .object({
    kind: z.literal("replay"),
    scenario: z.enum(["success", "exception"]),
    result: RunResultSchema,
  })
  .strict();

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
const READ_NOFOLLOW_FLAGS = fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

async function validateJsonLines(absolutePath: string, label: string): Promise<number> {
  const bytes = await requireRegularFile(absolutePath, label);
  const lines = bytes
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error(`${label} must contain at least one event.`);
  for (const [index, line] of lines.entries()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("event is not an object");
      }
    } catch {
      throw new Error(`${label} line ${index + 1} is not a JSON object.`);
    }
  }
  return lines.length;
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
    if (!bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
      throw new Error(`Run ${run.id} screenshot does not have a valid PNG signature.`);
    }
  }
  return [...manifestRefs.keys()];
}

async function validateNoSensitiveText(root: string, files: readonly string[]): Promise<void> {
  for (const relative of files) {
    if (FORBIDDEN_FILE.test(relative)) {
      throw new Error(`Forbidden raw evidence file ${relative}.`);
    }
    if (!TEXT_FILE.test(relative)) continue;
    const text = (await readFile(inside(root, relative), "utf8"))
      .replaceAll("[REDACTED:SECRET]", "")
      .replaceAll("[REDACTED:PII]", "")
      .replaceAll("[REDACTED:INTERNAL]", "");
    const findings = findSensitivePatterns(text);
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

  const manifest = EvidenceManifestSchema.parse(
    await jsonFile(path.join(root, "manifest.json"), "Evidence manifest"),
  );
  if (manifest.mode !== "live" && options.allowScriptedDiscovery !== true) {
    throw new Error("Committed evidence manifest must identify a live discovery mode.");
  }

  await validateHashes(root, manifest.artifact, manifest.artifactSha256, "Capability artifact");
  const artifact = CapabilityArtifactSchema.parse(
    await jsonFile(inside(root, manifest.artifact), "Capability artifact"),
  );
  if (!verifyArtifactDigest(artifact)) throw new Error("Capability artifact digest is invalid.");
  if (artifact.provenance.liveModel !== true && options.allowScriptedDiscovery !== true) {
    throw new Error("Capability artifact provenance must record liveModel true.");
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
  const stability = StabilitySchema.parse(
    await jsonFile(inside(root, manifest.stability.path), "Replay stability report"),
  );
  if (
    stability.artifactId !== artifact.id ||
    stability.artifactDigest !== artifact.digest ||
    stability.completedRuns !== stability.runs.length ||
    stability.requestedRuns !== stability.runs.length
  ) {
    throw new Error("Replay stability report identity or counts are inconsistent.");
  }
  const succeeded = stability.runs.filter((run) => run.status === "succeeded").length;
  if (
    stability.succeeded !== succeeded ||
    stability.successRate !== Number((succeeded / stability.runs.length).toFixed(4)) ||
    !stability.allZeroModelCalls ||
    stability.totalModelCalls !== 0 ||
    stability.runs.some((run) => run.modelCalls !== 0)
  ) {
    throw new Error("Replay stability report must accurately prove zero-model deterministic runs.");
  }

  const discoveryRuns = manifest.runs.filter((run) => run.kind === "discovery");
  const successReplays = manifest.runs.filter(
    (run) => run.kind === "replay" && run.scenario === "success",
  );
  const exceptionalReplays = manifest.runs.filter(
    (run) => run.kind === "replay" && run.scenario === "exception",
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
  for (const run of manifest.runs) {
    if (run.directory !== `runs/${run.id}`) {
      throw new Error(`Run ${run.id} directory must match its run identity.`);
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
    await validateJsonLines(inside(root, run.events), `Run ${run.id} events`);

    const screenshotDirectory = path.join(inside(root, run.directory), "screenshots");
    await requireDirectory(screenshotDirectory, `Run ${run.id} screenshots`);

    const summary = await jsonFile(inside(root, run.summary), `Run ${run.id} summary`);
    if (run.kind === "discovery") {
      const parsed = DiscoverySummarySchema.parse(summary);
      if (parsed.runId !== run.id || parsed.provenance.discoveryRunId !== run.id) {
        throw new Error("Discovery summary run identity is inconsistent.");
      }
      if (parsed.artifactDigest !== artifact.digest || parsed.artifactId !== artifact.id) {
        throw new Error("Discovery summary does not reference the root artifact.");
      }
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
      for (const screenshot of await validateRunScreenshots(root, run, parsed.evidence)) {
        if (referencedScreenshots.has(screenshot)) {
          throw new Error(`Screenshot ${screenshot} is referenced by more than one run.`);
        }
        referencedScreenshots.add(screenshot);
      }
    } else {
      const parsed = ReplaySummarySchema.parse(summary);
      if (parsed.scenario !== run.scenario || parsed.result.meta.runId !== run.id) {
        throw new Error(`Replay summary identity is inconsistent for ${run.id}.`);
      }
      if (parsed.result.meta.modelCalls !== 0) {
        throw new Error(`Replay ${run.id} must record modelCalls 0.`);
      }
      if (run.scenario === "success" && parsed.result.status !== "succeeded") {
        throw new Error(`Replay ${run.id} is labeled success but did not succeed.`);
      }
      if (run.scenario === "exception" && parsed.result.status === "succeeded") {
        throw new Error(`Replay ${run.id} is labeled exceptional but succeeded.`);
      }
      for (const screenshot of await validateRunScreenshots(
        root,
        run,
        replayEvidenceRefs(parsed.result),
      )) {
        if (referencedScreenshots.has(screenshot)) {
          throw new Error(`Screenshot ${screenshot} is referenced by more than one run.`);
        }
        referencedScreenshots.add(screenshot);
      }
    }
  }

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
