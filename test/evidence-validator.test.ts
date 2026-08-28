import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  assertAssignmentOutputContract,
  assertProjectedSuccessOutputs,
  sourceTreeSha256AtRevision,
  validateEvidenceBundle,
} from "../scripts/validate-evidence.js";
import { ArtifactApprovalSchema, CapabilityArtifactSchema } from "../src/domain/schema.js";
import { computeArtifactApprovalDigest } from "../src/runtime/artifact.js";

interface MutableScreenshotRef {
  relativePath: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
}

interface MutableManifestRun {
  id: string;
  kind: "discovery" | "replay";
  scenario: "success" | "exception" | "handoff";
  directory: string;
  summary: string;
  summarySha256: string;
  events: string;
  eventsSha256: string;
  artifact?: string;
  artifactSha256?: string;
  screenshots: MutableScreenshotRef[];
}

interface MutableManifest {
  mode: "scripted" | "live";
  model: {
    provider: string;
    modelId: string;
    liveModel: boolean;
    transport: "native-ollama" | "openai-compatible" | "scripted";
    digest?: string;
  };
  artifact: string;
  artifactSha256: string;
  artifactApproval: string;
  artifactApprovalSha256: string;
  stability: { path: string; sha256: string };
  provenance: {
    sourceRevision: string;
    sourceTreeSha256: string;
    nodeVersion: string;
    invocation: {
      command: "demo:offline" | "demo:live";
      planner: "scripted" | "live";
      replayRuns: number;
      screenshotModelInput: boolean;
      syntheticTarget: boolean;
      targetSource: "bundled-fixture" | "external";
    };
  };
  runs: MutableManifestRun[];
}

interface MutableEvidenceRef extends MutableScreenshotRef {
  id: string;
  kind: string;
}

interface MutableAssignmentArtifact {
  contract: {
    outcomes: Array<{
      code: string;
      when: {
        kind: string;
        target?: string;
        matcher?: { mode: string; value: string; caseSensitive: boolean };
      };
    }>;
  };
}

interface MutableSummary {
  kind: "discovery" | "replay";
  sessionId?: string;
  modelCalls?: number;
  recoveries?: number;
  evidence?: MutableEvidenceRef[];
  result?: {
    status: "succeeded" | "business_outcome" | "needs_intervention" | "failed";
    outcome?: { code: string; details?: Record<string, unknown> };
    meta?: {
      artifactId: string;
      artifactDigest: string;
      sessionId: string;
      startedAt: string;
      finishedAt: string;
      durationMs: number;
      modelCalls: number;
    };
    checkpointEvidence?: MutableEvidenceRef[];
    evidence?: MutableEvidenceRef[];
    intervention?: { evidence: MutableEvidenceRef[] };
    error?: { evidence: MutableEvidenceRef[] };
  };
  handoff?: {
    interventionId: string;
    originalSessionId: string;
    resumedSessionId: string;
    automationEpochBefore: number;
    operatorEpoch: number;
    automationEpochAfter: number;
    operatorAuditEvents: number;
    evidence: MutableEvidenceRef[];
  };
}

interface MutableStabilityRun {
  runId: string;
  status: "succeeded" | "business_outcome" | "needs_intervention" | "failed";
  durationMs: number;
  modelCalls: number;
}

interface MutableStability {
  latencyMs: { min: number; max: number; mean: number; p50: number; p95: number };
  runs: MutableStabilityRun[];
}

const temporaryDirectories: string[] = [];

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

async function clonedEvidence(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "handrail-evidence-validator-"));
  temporaryDirectories.push(parent);
  const root = path.join(parent, "evidence");
  await cp(path.resolve("evidence"), root, { recursive: true });
  return root;
}

async function readJson<T>(absolutePath: string): Promise<T> {
  return JSON.parse(await readFile(absolutePath, "utf8")) as T;
}

async function writeJson(absolutePath: string, value: unknown): Promise<void> {
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function summaryEvidence(summary: MutableSummary): MutableEvidenceRef[] {
  if (summary.kind === "discovery") return summary.evidence ?? [];
  const result = summary.result;
  if (!result) throw new Error("Replay summary is missing its result.");
  switch (result.status) {
    case "succeeded":
      return result.checkpointEvidence ?? [];
    case "business_outcome":
      return result.evidence ?? [];
    case "needs_intervention":
      return result.intervention?.evidence ?? [];
    case "failed":
      return result.error?.evidence ?? [];
  }
}

async function mutateFirstScreenshot(
  root: string,
  mutation: (manifestRef: MutableScreenshotRef, summaryRef: MutableEvidenceRef) => void,
): Promise<{ absolute: string; manifest: MutableManifest; run: MutableManifestRun }> {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = await readJson<MutableManifest>(manifestPath);
  const run = manifest.runs[0];
  const manifestRef = run?.screenshots[0];
  if (!run || !manifestRef) throw new Error("Fixture has no discovery screenshot ref.");
  const summaryPath = path.join(root, run.summary);
  const summary = await readJson<MutableSummary>(summaryPath);
  const runRelativePath = manifestRef.relativePath.slice(`${run.directory}/`.length);
  const summaryRef = summaryEvidence(summary).find(
    (ref) => ref.kind === "screenshot" && ref.relativePath === runRelativePath,
  );
  if (!summaryRef) throw new Error("Fixture summary has no matching screenshot ref.");
  mutation(manifestRef, summaryRef);
  await writeJson(summaryPath, summary);
  run.summarySha256 = digest(await readFile(summaryPath));
  await writeJson(manifestPath, manifest);
  return { absolute: path.join(root, manifestRef.relativePath), manifest, run };
}

async function updateRunSummary(
  root: string,
  run: MutableManifestRun,
  mutation: (summary: MutableSummary) => void,
): Promise<MutableSummary> {
  const summaryPath = path.join(root, run.summary);
  const summary = await readJson<MutableSummary>(summaryPath);
  mutation(summary);
  await writeJson(summaryPath, summary);
  run.summarySha256 = digest(await readFile(summaryPath));
  return summary;
}

async function updateRunEvents(
  root: string,
  run: MutableManifestRun,
  mutation: (events: Record<string, unknown>[]) => void,
): Promise<Record<string, unknown>[]> {
  const eventsPath = path.join(root, run.events);
  const events = (await readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  mutation(events);
  await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  run.eventsSha256 = digest(await readFile(eventsPath));
  return events;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function recomputeLatency(stability: MutableStability): void {
  const sorted = stability.runs.map((run) => run.durationMs).sort((left, right) => left - right);
  stability.latencyMs = {
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    mean: Number(
      (sorted.reduce((total, duration) => total + duration, 0) / sorted.length).toFixed(2),
    ),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

async function updateStability(
  root: string,
  manifest: MutableManifest,
  mutation: (stability: MutableStability) => void,
): Promise<MutableStability> {
  const stabilityPath = path.join(root, manifest.stability.path);
  const stability = await readJson<MutableStability>(stabilityPath);
  mutation(stability);
  await writeJson(stabilityPath, stability);
  manifest.stability.sha256 = digest(await readFile(stabilityPath));
  return stability;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("strict screenshot evidence validation", () => {
  it("accepts only the assignment output projection and declared outcome predicate", async () => {
    const manifest = await readJson<MutableManifest>(path.resolve("evidence/manifest.json"));
    const artifact = CapabilityArtifactSchema.parse(
      await readJson<unknown>(path.resolve("evidence", manifest.artifact)),
    );

    assert.doesNotThrow(() => assertAssignmentOutputContract(artifact));
    assert.doesNotThrow(() =>
      assertProjectedSuccessOutputs(
        "projection-positive",
        {
          savingsBalance: "[REDACTED:INTERNAL]",
        },
        artifact,
      ),
    );
    assert.throws(
      () => assertProjectedSuccessOutputs("projection-raw", { savingsBalance: 1_284.37 }, artifact),
      /classification\/redaction contract/u,
    );
    assert.throws(
      () =>
        assertProjectedSuccessOutputs(
          "projection-wrong-marker",
          { savingsBalance: "[REDACTED:PII]" },
          artifact,
        ),
      /classification\/redaction contract/u,
    );
    assert.throws(
      () =>
        assertProjectedSuccessOutputs(
          "projection-extra",
          { savingsBalance: "[REDACTED:INTERNAL]", undeclared: "value" },
          artifact,
        ),
      /exact success output-key contract/u,
    );
    assert.throws(
      () => assertProjectedSuccessOutputs("projection-missing", {}, artifact),
      /exact success output-key contract/u,
    );

    const removed = structuredClone(artifact) as unknown as MutableAssignmentArtifact;
    removed.contract.outcomes = [];
    assert.throws(
      () => assertAssignmentOutputContract(CapabilityArtifactSchema.parse(removed)),
      /exact MEMBER_NOT_FOUND outcome and target-text predicate/u,
    );

    const rebound = structuredClone(artifact) as unknown as MutableAssignmentArtifact;
    const reboundOutcome = rebound.contract.outcomes[0];
    if (!reboundOutcome) throw new Error("Artifact fixture has no declared outcome.");
    reboundOutcome.code = "UNRELATED_OUTCOME";
    assert.throws(
      () => assertAssignmentOutputContract(CapabilityArtifactSchema.parse(rebound)),
      /exact MEMBER_NOT_FOUND outcome and target-text predicate/u,
    );
  });

  it("hashes an immutable real commit rather than the mutable working tree", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "handrail-source-revision-"));
    temporaryDirectories.push(repository);
    await git(["-C", repository, "init", "--quiet"]);
    await git(["-C", repository, "config", "user.name", "Evidence Test"]);
    await git(["-C", repository, "config", "user.email", "evidence-test@example.invalid"]);
    await mkdir(path.join(repository, "src"));
    const sourcePath = path.join(repository, "src", "index.ts");
    const committedBytes = Buffer.from("export const value = 1;\n");
    await writeFile(sourcePath, committedBytes);
    await git(["-C", repository, "add", "src/index.ts"]);
    await git(["-C", repository, "commit", "--quiet", "-m", "fixture"]);
    const revision = await git(["-C", repository, "rev-parse", "HEAD"]);
    const expected = digest(
      Buffer.concat([Buffer.from("index.ts\0"), committedBytes, Buffer.from("\0")]),
    );

    assert.equal(await sourceTreeSha256AtRevision(repository, revision), expected);
    await writeFile(sourcePath, "export const value = 2;\n");
    assert.equal(await sourceTreeSha256AtRevision(repository, revision), expected);
    await assert.rejects(
      sourceTreeSha256AtRevision(repository, "0".repeat(40)),
      /is not an available Git commit/u,
    );
  });

  it("accepts the complete committed live evidence inventory", async () => {
    const report = await validateEvidenceBundle(path.resolve("evidence"));
    assert.ok(report.runs >= 13);
    assert.equal(report.replayRunIds.length, report.runs - 1);
  });

  it("rejects replay results rebound to a different artifact identity", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const replay = manifest.runs.find((run) => run.kind === "replay");
    if (!replay) throw new Error("Fixture has no replay run.");
    await updateRunSummary(root, replay, (summary) => {
      if (!summary.result?.meta) throw new Error("Replay summary has no result metadata.");
      summary.result.meta.artifactId = "substituted-artifact";
      summary.result.meta.artifactDigest = "f".repeat(64);
    });
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /not bound to the root artifact identity/u);
  });

  it("requires the exceptional replay to prove MEMBER_NOT_FOUND", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const exceptional = manifest.runs.find((run) => run.scenario === "exception");
    if (!exceptional) throw new Error("Fixture has no exceptional replay.");
    await updateRunSummary(root, exceptional, (summary) => {
      if (summary.result?.status !== "business_outcome" || !summary.result.outcome) {
        throw new Error("Exceptional replay fixture has no business outcome.");
      }
      summary.result.outcome.code = "UNRELATED_OUTCOME";
    });
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /must prove.*MEMBER_NOT_FOUND/u);
  });

  it("rejects a two-event MEMBER_NOT_FOUND claim without step or terminal-checkpoint proof", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const exceptional = manifest.runs.find((run) => run.scenario === "exception");
    if (!exceptional) throw new Error("Fixture has no exceptional replay.");
    await updateRunSummary(root, exceptional, (summary) => {
      if (summary.result?.status !== "business_outcome" || !summary.result.outcome) {
        throw new Error("Exceptional replay fixture has no business outcome.");
      }
      summary.result.outcome.details = { stepId: "step-01-set-memberId", predicateMatched: true };
    });
    await updateRunEvents(root, exceptional, (events) => {
      const started = events[0];
      const terminal = events.at(-1);
      if (!started || !terminal) throw new Error("Exceptional replay has no terminal events.");
      terminal.sequence = 1;
      events.splice(0, events.length, started, terminal);
    });
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /pending step or full terminal-checkpoint/u);
  });

  it("enforces the exact success output key, type, and classification projection", async () => {
    const extraRoot = await clonedEvidence();
    const extraManifestPath = path.join(extraRoot, "manifest.json");
    const extraManifest = await readJson<MutableManifest>(extraManifestPath);
    const discovery = extraManifest.runs.find((run) => run.kind === "discovery");
    if (!discovery) throw new Error("Fixture has no discovery run.");
    await updateRunSummary(extraRoot, discovery, (summary) => {
      const outputs = summary as MutableSummary & { outputs?: Record<string, unknown> };
      if (!outputs.outputs) throw new Error("Discovery fixture has no outputs.");
      outputs.outputs.unreviewedOutput = 1;
    });
    await writeJson(extraManifestPath, extraManifest);
    await assert.rejects(validateEvidenceBundle(extraRoot), /exact success output-key contract/u);

    const invalidRoot = await clonedEvidence();
    const invalidManifestPath = path.join(invalidRoot, "manifest.json");
    const invalidManifest = await readJson<MutableManifest>(invalidManifestPath);
    const replay = invalidManifest.runs.find(
      (run) => run.kind === "replay" && run.scenario === "success",
    );
    if (!replay) throw new Error("Fixture has no successful replay.");
    await updateRunSummary(invalidRoot, replay, (summary) => {
      const outputs = summary.result as
        | (NonNullable<MutableSummary["result"]> & { outputs?: Record<string, unknown> })
        | undefined;
      if (!outputs?.outputs) throw new Error("Replay fixture has no outputs.");
      outputs.outputs.savingsBalance = "[REDACTED:PII]";
    });
    await writeJson(invalidManifestPath, invalidManifest);
    await assert.rejects(
      validateEvidenceBundle(invalidRoot),
      /classification\/redaction contract/u,
    );
  });

  it("rejects replay evidence created before its artifact approval was valid", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const replay = manifest.runs.find((run) => run.kind === "replay");
    if (!replay) throw new Error("Fixture has no replay run.");
    const eventsPath = path.join(root, replay.events);
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const started = events.find((event) => event.type === "replay.started");
    if (!started) throw new Error("Replay fixture has no start event.");
    started.timestamp = "2000-01-01T00:00:00.000Z";
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    replay.eventsSha256 = digest(await readFile(eventsPath));
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /approval validity window/u);
  });

  it("requires the discovery artifact file to exactly match the root artifact", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const discovery = manifest.runs.find((run) => run.kind === "discovery");
    if (!discovery?.artifact) throw new Error("Fixture has no discovery artifact binding.");
    const artifactPath = path.join(root, discovery.artifact);
    await writeFile(artifactPath, `${await readFile(artifactPath, "utf8")}\n`, "utf8");
    discovery.artifactSha256 = digest(await readFile(artifactPath));
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /hash-bound to the root artifact/u);
  });

  it("rejects unreferenced structured files inside an otherwise valid run", async () => {
    const root = await clonedEvidence();
    const manifest = await readJson<MutableManifest>(path.join(root, "manifest.json"));
    const run = manifest.runs[0];
    if (!run) throw new Error("Fixture has no run.");
    await writeJson(path.join(root, run.directory, "untracked.json"), { hidden: "payload" });

    await assert.rejects(validateEvidenceBundle(root), /file inventory is not exact/u);
  });

  it("rejects non-pattern canary fields outside minimized summary and event schemas", async () => {
    const summaryRoot = await clonedEvidence();
    const summaryManifestPath = path.join(summaryRoot, "manifest.json");
    const summaryManifest = await readJson<MutableManifest>(summaryManifestPath);
    const discovery = summaryManifest.runs.find((run) => run.kind === "discovery");
    if (!discovery) throw new Error("Fixture has no discovery run.");
    await updateRunSummary(summaryRoot, discovery, (summary) => {
      (summary as unknown as Record<string, unknown>).rawCustomerLabel = "ordinary canary";
    });
    await writeJson(summaryManifestPath, summaryManifest);
    await assert.rejects(validateEvidenceBundle(summaryRoot), /unrecognized_keys/u);

    const eventRoot = await clonedEvidence();
    const eventManifestPath = path.join(eventRoot, "manifest.json");
    const eventManifest = await readJson<MutableManifest>(eventManifestPath);
    const handoff = eventManifest.runs.find((run) => run.scenario === "handoff");
    if (!handoff) throw new Error("Fixture has no handoff replay.");
    await updateRunEvents(eventRoot, handoff, (events) => {
      const operatorEvent = events.find((event) => event.type === "operator.audit");
      if (!operatorEvent) throw new Error("Handoff fixture has no operator audit.");
      operatorEvent.rawBalanceLabel = "ordinary canary";
    });
    await writeJson(eventManifestPath, eventManifest);
    await assert.rejects(validateEvidenceBundle(eventRoot), /typed replay event contract/u);
  });

  it("rejects a handoff summary whose epochs are not proven by the operator audit", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const handoffRun = manifest.runs.find((run) => run.scenario === "handoff");
    if (!handoffRun) throw new Error("Fixture has no handoff replay.");
    await updateRunSummary(root, handoffRun, (summary) => {
      if (!summary.handoff) throw new Error("Handoff replay has no handoff summary.");
      summary.handoff.operatorEpoch += 10;
      summary.handoff.automationEpochAfter += 10;
    });
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /operator audit epochs or actors/u);
  });

  it("rejects operator audit events from a substituted handoff session", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const handoffRun = manifest.runs.find((run) => run.scenario === "handoff");
    if (!handoffRun) throw new Error("Fixture has no handoff replay.");
    const eventsPath = path.join(root, handoffRun.events);
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const operatorEvent = events.find((event) => event.type === "operator.audit");
    if (!operatorEvent) throw new Error("Handoff replay has no operator audit.");
    operatorEvent.sessionId = "surface-substituted-session";
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    handoffRun.eventsSha256 = digest(await readFile(eventsPath));
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /count or session binding is inconsistent/u);
  });

  it("rejects handoff capture events rebound away from their screenshot evidence", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const handoffRun = manifest.runs.find((run) => run.scenario === "handoff");
    if (!handoffRun) throw new Error("Fixture has no handoff replay.");
    const eventsPath = path.join(root, handoffRun.events);
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const capture = events.find(
      (event) => event.type === "operator.audit" && event.action === "evidence_captured",
    );
    if (!capture || typeof capture.details !== "object" || capture.details === null) {
      throw new Error("Handoff replay has no capture audit.");
    }
    (capture.details as Record<string, unknown>).sha256 = "0".repeat(64);
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    handoffRun.eventsSha256 = digest(await readFile(eventsPath));
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /capture audit is not bound/u);
  });

  it("rejects identical before/after capture bytes as recovery evidence", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const handoffRun = manifest.runs.find((run) => run.scenario === "handoff");
    if (!handoffRun) throw new Error("Fixture has no handoff replay.");

    let firstCapture: MutableEvidenceRef | undefined;
    let secondCapture: MutableEvidenceRef | undefined;
    await updateRunSummary(root, handoffRun, (summary) => {
      firstCapture = summary.handoff?.evidence[0];
      secondCapture = summary.handoff?.evidence[1];
      if (!firstCapture || !secondCapture) {
        throw new Error("Handoff fixture needs before and after captures.");
      }
      secondCapture.id = firstCapture.id;
      secondCapture.sha256 = firstCapture.sha256;
      secondCapture.byteLength = firstCapture.byteLength;
    });
    if (!firstCapture || !secondCapture) {
      throw new Error("Handoff fixture capture mutation was not retained.");
    }
    await copyFile(
      path.join(root, handoffRun.directory, firstCapture.relativePath),
      path.join(root, handoffRun.directory, secondCapture.relativePath),
    );
    const secondManifestRef = handoffRun.screenshots.find(
      (ref) => ref.relativePath === `${handoffRun.directory}/${secondCapture?.relativePath}`,
    );
    if (!secondManifestRef) throw new Error("Handoff manifest lacks the after capture.");
    secondManifestRef.sha256 = firstCapture.sha256;
    secondManifestRef.byteLength = firstCapture.byteLength;
    const secondCaptureId = path.posix.basename(secondCapture.relativePath, ".png");
    await updateRunEvents(root, handoffRun, (events) => {
      const captureEvent = events.find(
        (event) =>
          event.type === "operator.audit" &&
          event.action === "evidence_captured" &&
          typeof event.details === "object" &&
          event.details !== null &&
          (event.details as Record<string, unknown>).captureId === secondCaptureId,
      );
      if (!captureEvent || typeof captureEvent.details !== "object" || !captureEvent.details) {
        throw new Error("Handoff fixture lacks the after capture audit.");
      }
      (captureEvent.details as Record<string, unknown>).sha256 = firstCapture?.sha256;
      (captureEvent.details as Record<string, unknown>).byteLength = firstCapture?.byteLength;
    });
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      validateEvidenceBundle(root),
      /distinct before\/after captures around an authorized recovery click/u,
    );
  });

  it("rejects operator completions without a matching pre-dispatch authorization event", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const handoffRun = manifest.runs.find((run) => run.scenario === "handoff");
    if (!handoffRun) throw new Error("Fixture has no handoff replay.");
    const eventsPath = path.join(root, handoffRun.events);
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const authorization = events.find(
      (event) => event.type === "operator.audit" && event.action === "operator_action_authorized",
    );
    if (
      !authorization ||
      typeof authorization.details !== "object" ||
      authorization.details === null
    ) {
      throw new Error("Handoff replay has no operator authorization audit.");
    }
    (authorization.details as Record<string, unknown>).action = "mismatched_action";
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    handoffRun.eventsSha256 = digest(await readFile(eventsPath));
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /not bound to its action/u);
  });

  it("requires the recovery click to be authorized and bracketed by before/after captures", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const handoff = manifest.runs.find((run) => run.scenario === "handoff");
    if (!handoff) throw new Error("Fixture has no handoff replay.");
    await updateRunEvents(root, handoff, (events) => {
      const clickIndex = events.findIndex(
        (event) => event.type === "operator.audit" && event.action === "operator_clicked",
      );
      const click = events[clickIndex];
      const authorization = events[clickIndex - 1];
      if (
        !click ||
        !authorization ||
        authorization.action !== "operator_action_authorized" ||
        typeof authorization.details !== "object" ||
        authorization.details === null ||
        typeof click.details !== "object" ||
        click.details === null
      ) {
        throw new Error("Handoff fixture has no authorized click pair.");
      }
      const policyGrantMode = (authorization.details as Record<string, unknown>).policyGrantMode;
      authorization.details = {
        action: "press_key",
        effect: "read",
        policyGrantMode,
        key: "Tab",
      };
      click.action = "operator_pressed_key";
      click.details = { effect: "read", policyGrantMode, key: "Tab" };
    });
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      validateEvidenceBundle(root),
      /before\/after captures around an authorized recovery click/u,
    );
  });

  it("rejects a discovery decision rebound to a stale observation", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const discovery = manifest.runs.find((run) => run.kind === "discovery");
    if (!discovery) throw new Error("Fixture has no discovery run.");
    await updateRunEvents(root, discovery, (events) => {
      const observations = events.filter((event) => event.type === "observation.captured");
      const decision = events.find((event) => event.type === "model.decision");
      const stale = observations[1]?.observationId;
      if (
        !decision ||
        typeof decision.decision !== "object" ||
        decision.decision === null ||
        !stale
      ) {
        throw new Error("Discovery fixture lacks an observation-bound decision.");
      }
      (decision.decision as Record<string, unknown>).observationId = stale;
    });
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /not bound to the current observation/u);
  });

  it("rejects replay events with missing typed fields and out-of-order step completion", async () => {
    const missingFieldRoot = await clonedEvidence();
    const missingManifestPath = path.join(missingFieldRoot, "manifest.json");
    const missingManifest = await readJson<MutableManifest>(missingManifestPath);
    const missingReplay = missingManifest.runs.find(
      (run) => run.kind === "replay" && run.scenario === "success",
    );
    if (!missingReplay) throw new Error("Fixture has no successful replay.");
    await updateRunEvents(missingFieldRoot, missingReplay, (events) => {
      const attempt = events.find((event) => event.type === "replay.step.attempt");
      if (!attempt) throw new Error("Replay fixture has no step attempt.");
      delete attempt.command;
    });
    await writeJson(missingManifestPath, missingManifest);
    await assert.rejects(validateEvidenceBundle(missingFieldRoot), /typed replay event contract/u);

    const reorderedRoot = await clonedEvidence();
    const reorderedManifestPath = path.join(reorderedRoot, "manifest.json");
    const reorderedManifest = await readJson<MutableManifest>(reorderedManifestPath);
    const reorderedReplay = reorderedManifest.runs.find(
      (run) => run.kind === "replay" && run.scenario === "success",
    );
    if (!reorderedReplay) throw new Error("Fixture has no successful replay.");
    await updateRunEvents(reorderedRoot, reorderedReplay, (events) => {
      const attempts = events.filter((event) => event.type === "replay.step.attempt");
      const completed = events.find((event) => event.type === "replay.step.completed");
      const laterStepId = attempts[1]?.stepId;
      if (!completed || typeof laterStepId !== "string") {
        throw new Error("Replay fixture lacks multiple artifact steps.");
      }
      completed.stepId = laterStepId;
    });
    await writeJson(reorderedManifestPath, reorderedManifest);
    await assert.rejects(validateEvidenceBundle(reorderedRoot), /completion lacks its matching/u);
  });

  it("rejects an initial replay attempt that skips directly to a retry number", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const replay = manifest.runs.find((run) => run.kind === "replay" && run.scenario === "success");
    if (!replay) throw new Error("Fixture has no successful replay.");
    await updateRunEvents(root, replay, (events) => {
      const attempt = events.find((event) => event.type === "replay.step.attempt");
      if (!attempt || typeof attempt.stepId !== "string") {
        throw new Error("Replay fixture has no initial step attempt.");
      }
      const completion = events.find(
        (event) => event.type === "replay.step.completed" && event.stepId === attempt.stepId,
      );
      if (!completion) throw new Error("Replay fixture has no matching completion.");
      attempt.attempt = 2;
      completion.attempt = 2;
    });
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /outside artifact order or retry bounds/u);
  });

  it("requires every stability replay to use a unique fresh session", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const successes = manifest.runs.filter(
      (run) => run.kind === "replay" && run.scenario === "success",
    );
    const first = successes[0];
    const second = successes[1];
    if (!first || !second) throw new Error("Fixture needs at least two successful replays.");
    const firstSummary = await readJson<MutableSummary>(path.join(root, first.summary));
    const sharedSessionId = firstSummary.result?.meta?.sessionId;
    if (!sharedSessionId) throw new Error("Replay fixture has no session metadata.");
    await updateRunSummary(root, second, (summary) => {
      if (!summary.result?.meta) throw new Error("Replay fixture has no result metadata.");
      summary.result.meta.sessionId = sharedSessionId;
    });
    await updateRunEvents(root, second, (events) => {
      for (const event of events) {
        if (Object.hasOwn(event, "sessionId")) event.sessionId = sharedSessionId;
      }
    });
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /unique fresh surface session/u);
  });

  it("binds stability durations to replay metadata and recomputes every latency statistic", async () => {
    const durationRoot = await clonedEvidence();
    const durationManifestPath = path.join(durationRoot, "manifest.json");
    const durationManifest = await readJson<MutableManifest>(durationManifestPath);
    await updateStability(durationRoot, durationManifest, (stability) => {
      const first = stability.runs[0];
      if (!first) throw new Error("Stability fixture has no runs.");
      first.durationMs += 17;
      recomputeLatency(stability);
    });
    await writeJson(durationManifestPath, durationManifest);
    await assert.rejects(validateEvidenceBundle(durationRoot), /not bound to its stability entry/u);

    const latencyRoot = await clonedEvidence();
    const latencyManifestPath = path.join(latencyRoot, "manifest.json");
    const latencyManifest = await readJson<MutableManifest>(latencyManifestPath);
    await updateStability(latencyRoot, latencyManifest, (stability) => {
      stability.latencyMs.p95 += 1;
    });
    await writeJson(latencyManifestPath, latencyManifest);
    await assert.rejects(validateEvidenceBundle(latencyRoot), /statistics do not recompute/u);
  });

  it("binds replay durations to their lifecycle timestamps", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const replay = manifest.runs.find((run) => run.scenario === "success");
    if (!replay) throw new Error("Fixture has no successful replay.");
    await updateRunSummary(root, replay, (summary) => {
      if (!summary.result?.meta) throw new Error("Replay fixture has no result metadata.");
      summary.result.meta.durationMs = 1;
    });
    await updateRunEvents(root, replay, (events) => {
      const terminal = events.at(-1);
      if (terminal?.type !== "replay.completed") {
        throw new Error("Replay fixture has no terminal event.");
      }
      terminal.durationMs = 1;
    });
    await updateStability(root, manifest, (stability) => {
      const entry = stability.runs.find((run) => run.runId === replay.id);
      if (!entry) throw new Error("Replay fixture has no stability entry.");
      entry.durationMs = 1;
      recomputeLatency(stability);
    });
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /duration does not match/u);
  });

  it("rejects an artifact approval issued before discovery completed", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const discovery = manifest.runs.find((run) => run.kind === "discovery");
    if (!discovery) throw new Error("Fixture has no discovery run.");
    const discoveryEvents = await updateRunEvents(root, discovery, () => undefined);
    const completed = discoveryEvents.at(-1);
    if (!completed || typeof completed.timestamp !== "string") {
      throw new Error("Discovery fixture has no completion timestamp.");
    }
    const approvalPath = path.join(root, manifest.artifactApproval);
    const approval = await readJson<Record<string, unknown>>(approvalPath);
    approval.approvedAt = new Date(Date.parse(completed.timestamp) - 1).toISOString();
    await writeJson(approvalPath, approval);
    manifest.artifactApprovalSha256 = digest(await readFile(approvalPath));
    const approvalDigest = computeArtifactApprovalDigest(ArtifactApprovalSchema.parse(approval));
    for (const replay of manifest.runs.filter((run) => run.kind === "replay")) {
      await updateRunEvents(root, replay, (events) => {
        const started = events[0];
        if (started?.type !== "replay.started") {
          throw new Error("Replay fixture has no start event.");
        }
        started.artifactApprovalDigest = approvalDigest;
      });
    }
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /approval must be issued after/u);
  });

  it("requires committed live evidence to identify the native local Ollama provider", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    manifest.model.provider = "ollama-remote-approved";
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /native local Ollama model identity/u);

    const transportRoot = await clonedEvidence();
    const transportManifestPath = path.join(transportRoot, "manifest.json");
    const transportManifest = await readJson<MutableManifest>(transportManifestPath);
    transportManifest.model.transport = "openai-compatible";
    await writeJson(transportManifestPath, transportManifest);
    await assert.rejects(
      validateEvidenceBundle(transportRoot),
      /native local Ollama model identity/u,
    );

    const digestRoot = await clonedEvidence();
    const digestManifestPath = path.join(digestRoot, "manifest.json");
    const digestManifest = await readJson<MutableManifest>(digestManifestPath);
    delete digestManifest.model.digest;
    await writeJson(digestManifestPath, digestManifest);
    await assert.rejects(validateEvidenceBundle(digestRoot), /SHA-256-bound native local Ollama/u);
  });

  it("binds committed live evidence to the internally started bundled target", async () => {
    const inconsistentRoot = await clonedEvidence();
    const inconsistentManifestPath = path.join(inconsistentRoot, "manifest.json");
    const inconsistentManifest = await readJson<MutableManifest>(inconsistentManifestPath);
    inconsistentManifest.provenance.invocation.targetSource = "external";
    inconsistentManifest.provenance.invocation.syntheticTarget = true;
    await writeJson(inconsistentManifestPath, inconsistentManifest);
    await assert.rejects(
      validateEvidenceBundle(inconsistentRoot),
      /target source and synthetic-target provenance are inconsistent/u,
    );

    const externalRoot = await clonedEvidence();
    const externalManifestPath = path.join(externalRoot, "manifest.json");
    const externalManifest = await readJson<MutableManifest>(externalManifestPath);
    externalManifest.provenance.invocation.targetSource = "external";
    externalManifest.provenance.invocation.syntheticTarget = false;
    await writeJson(externalManifestPath, externalManifest);
    await assert.rejects(
      validateEvidenceBundle(externalRoot),
      /revision-bound, semantic-only, synthetic-target invocation/u,
    );
  });

  it("rejects handoff completions whose safe effect or policy grant differs from authorization", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const handoff = manifest.runs.find((run) => run.scenario === "handoff");
    if (!handoff) throw new Error("Fixture has no handoff replay.");
    await updateRunEvents(root, handoff, (events) => {
      const authorizationIndex = events.findIndex(
        (event) => event.type === "operator.audit" && event.action === "operator_action_authorized",
      );
      const completion = events
        .slice(authorizationIndex + 1)
        .find(
          (event) =>
            event.type === "operator.audit" &&
            [
              "operator_clicked",
              "operator_typed",
              "operator_pressed_key",
              "evidence_captured",
            ].includes(String(event.action)),
        );
      if (!completion || typeof completion.details !== "object" || completion.details === null) {
        throw new Error("Handoff fixture has no authorized completion.");
      }
      (completion.details as Record<string, unknown>).policyGrantMode = "substituted_grant";
    });
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /action, effect, and policy grant/u);
  });

  it("binds the contiguous handoff audit block to the interrupted step and resumed observation", async () => {
    const observationRoot = await clonedEvidence();
    const observationManifestPath = path.join(observationRoot, "manifest.json");
    const observationManifest = await readJson<MutableManifest>(observationManifestPath);
    const observationHandoff = observationManifest.runs.find((run) => run.scenario === "handoff");
    if (!observationHandoff) throw new Error("Fixture has no handoff replay.");
    await updateRunEvents(observationRoot, observationHandoff, (events) => {
      const returned = events.find(
        (event) => event.type === "operator.audit" && event.action === "control_returned",
      );
      if (!returned || typeof returned.details !== "object" || returned.details === null) {
        throw new Error("Handoff fixture has no control-return event.");
      }
      (returned.details as Record<string, unknown>).freshObservationId =
        "observation-substituted-resume";
    });
    await writeJson(observationManifestPath, observationManifest);
    await assert.rejects(validateEvidenceBundle(observationRoot), /resume observation/u);

    const interleavedRoot = await clonedEvidence();
    const interleavedManifestPath = path.join(interleavedRoot, "manifest.json");
    const interleavedManifest = await readJson<MutableManifest>(interleavedManifestPath);
    const interleavedHandoff = interleavedManifest.runs.find((run) => run.scenario === "handoff");
    if (!interleavedHandoff) throw new Error("Fixture has no handoff replay.");
    await updateRunEvents(interleavedRoot, interleavedHandoff, (events) => {
      const firstOperatorIndex = events.findIndex((event) => event.type === "operator.audit");
      const template = events[firstOperatorIndex];
      if (firstOperatorIndex < 0 || !template)
        throw new Error("Handoff fixture has no audit block.");
      events.splice(firstOperatorIndex + 1, 0, {
        schemaVersion: "1.0.0",
        eventId: "evt_injected_replay_execution",
        sequence: 0,
        timestamp: template.timestamp,
        runId: template.runId,
        correlationId: template.correlationId,
        actor: "automation",
        ownerEpoch: 0,
        type: "replay.surface.recovered",
        code: "KNOWN_TRANSIENT",
        checks: 1,
        modelCalls: 0,
      });
      events.forEach((event, index) => {
        event.sequence = index;
      });
    });
    await writeJson(interleavedManifestPath, interleavedManifest);
    await assert.rejects(validateEvidenceBundle(interleavedRoot), /handoff audit block/u);
  });

  it("rejects nonexistent and real-but-mismatched source revisions", async () => {
    const missingRoot = await clonedEvidence();
    const missingManifestPath = path.join(missingRoot, "manifest.json");
    const missingManifest = await readJson<MutableManifest>(missingManifestPath);
    missingManifest.provenance.sourceRevision = "0".repeat(40);
    await writeJson(missingManifestPath, missingManifest);
    await assert.rejects(validateEvidenceBundle(missingRoot), /is not an available Git commit/u);

    const mismatchRoot = await clonedEvidence();
    const mismatchManifestPath = path.join(mismatchRoot, "manifest.json");
    const mismatchManifest = await readJson<MutableManifest>(mismatchManifestPath);
    const revisions = (await git(["rev-list", "--all"])).split("\n").filter(Boolean);
    let mismatchedRevision: string | undefined;
    for (const revision of revisions) {
      try {
        const candidateTree = await sourceTreeSha256AtRevision(path.resolve("."), revision);
        if (candidateTree !== mismatchManifest.provenance.sourceTreeSha256) {
          mismatchedRevision = revision;
          break;
        }
      } catch {
        // Historical commits without a src tree cannot satisfy the manifest either.
      }
    }
    assert.ok(mismatchedRevision, "Repository history must contain a distinct src revision.");
    mismatchManifest.provenance.sourceRevision = mismatchedRevision;
    await writeJson(mismatchManifestPath, mismatchManifest);
    await assert.rejects(validateEvidenceBundle(mismatchRoot), /does not contain the source tree/u);
  });

  it("rejects hash-valid structured evidence hidden behind an unscanned extension", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const run = manifest.runs[0];
    if (!run) throw new Error("Fixture has no run.");
    const original = path.join(root, run.summary);
    const disguisedRelative = `${run.directory}/summary.bin`;
    await rename(original, path.join(root, disguisedRelative));
    run.summary = disguisedRelative;
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /unsupported file type/u);
  });

  it("rejects screenshot bytes whose SHA-256 no longer matches the refs", async () => {
    const root = await clonedEvidence();
    const manifest = await readJson<MutableManifest>(path.join(root, "manifest.json"));
    const relativePath = manifest.runs[0]?.screenshots[0]?.relativePath;
    if (!relativePath) throw new Error("Fixture has no screenshot.");
    const absolute = path.join(root, relativePath);
    const bytes = await readFile(absolute);
    bytes[PNG_HEADER_BYTES] = (bytes[PNG_HEADER_BYTES] ?? 0) ^ 1;
    await writeFile(absolute, bytes);

    await assert.rejects(validateEvidenceBundle(root), /screenshot SHA-256 does not match/u);
  });

  it("rejects a screenshot byteLength mismatch even when both refs agree", async () => {
    const root = await clonedEvidence();
    await mutateFirstScreenshot(root, (manifestRef, summaryRef) => {
      manifestRef.byteLength += 1;
      summaryRef.byteLength = manifestRef.byteLength;
    });

    await assert.rejects(validateEvidenceBundle(root), /screenshot byteLength does not match/u);
  });

  it("rejects a non-PNG MIME declaration", async () => {
    const root = await clonedEvidence();
    await mutateFirstScreenshot(root, (manifestRef, summaryRef) => {
      manifestRef.mimeType = "image/jpeg";
      summaryRef.mimeType = "image/jpeg";
    });

    await assert.rejects(validateEvidenceBundle(root));
  });

  it("rejects invalid PNG bytes even when their hashes and lengths are rebound", async () => {
    const root = await clonedEvidence();
    const invalid = Buffer.from("not-a-png");
    const changed = await mutateFirstScreenshot(root, (manifestRef, summaryRef) => {
      manifestRef.sha256 = digest(invalid);
      manifestRef.byteLength = invalid.byteLength;
      summaryRef.sha256 = manifestRef.sha256;
      summaryRef.byteLength = manifestRef.byteLength;
      summaryRef.id = `ev_${manifestRef.sha256.slice(0, 24)}`;
    });
    await writeFile(changed.absolute, invalid);

    await assert.rejects(validateEvidenceBundle(root), /valid PNG signature/u);
  });

  it("rejects a truncated PNG with a valid signature after every ref is rebound", async () => {
    const root = await clonedEvidence();
    const invalid = Buffer.concat([PNG_SIGNATURE, Buffer.from("junk")]);
    const changed = await mutateFirstScreenshot(root, (manifestRef, summaryRef) => {
      manifestRef.sha256 = digest(invalid);
      manifestRef.byteLength = invalid.byteLength;
      summaryRef.sha256 = manifestRef.sha256;
      summaryRef.byteLength = manifestRef.byteLength;
      summaryRef.id = `ev_${manifestRef.sha256.slice(0, 24)}`;
    });
    await writeFile(changed.absolute, invalid);

    await assert.rejects(validateEvidenceBundle(root), /not a valid PNG/u);
  });

  it("rejects duplicate and escaping screenshot refs", async () => {
    const duplicateRoot = await clonedEvidence();
    const duplicateManifestPath = path.join(duplicateRoot, "manifest.json");
    const duplicateManifest = await readJson<MutableManifest>(duplicateManifestPath);
    const duplicateRun = duplicateManifest.runs[0];
    const duplicateRef = duplicateRun?.screenshots[0];
    if (!duplicateRun || !duplicateRef) throw new Error("Fixture has no screenshot.");
    duplicateRun.screenshots.push({ ...duplicateRef });
    await writeJson(duplicateManifestPath, duplicateManifest);
    await assert.rejects(validateEvidenceBundle(duplicateRoot), /duplicate screenshot refs/u);

    const escapingRoot = await clonedEvidence();
    const escapingManifestPath = path.join(escapingRoot, "manifest.json");
    const escapingManifest = await readJson<MutableManifest>(escapingManifestPath);
    const escapingRef = escapingManifest.runs[0]?.screenshots[0];
    if (!escapingRef) throw new Error("Fixture has no screenshot.");
    escapingRef.relativePath = "../outside.png";
    await writeJson(escapingManifestPath, escapingManifest);
    await assert.rejects(validateEvidenceBundle(escapingRoot));
  });

  it("rejects duplicate manifest run identities", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const replay = manifest.runs.find((run) => run.id.includes("replay-success"));
    if (!replay) throw new Error("Fixture has no replay run.");
    manifest.runs.push(structuredClone(replay));
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root), /run IDs must be unique/u);
  });

  it("rejects unreferenced PNG content regardless of extension and screenshot symlinks", async () => {
    const extraRoot = await clonedEvidence();
    const extraManifest = await readJson<MutableManifest>(path.join(extraRoot, "manifest.json"));
    const source = extraManifest.runs[0]?.screenshots[0]?.relativePath;
    if (!source) throw new Error("Fixture has no screenshot.");
    await copyFile(path.join(extraRoot, source), path.join(extraRoot, "unreferenced.png"));
    await assert.rejects(validateEvidenceBundle(extraRoot), /unreferenced PNG screenshot/u);

    const renamedRoot = await clonedEvidence();
    const renamedManifest = await readJson<MutableManifest>(
      path.join(renamedRoot, "manifest.json"),
    );
    const renamedSource = renamedManifest.runs[0]?.screenshots[0]?.relativePath;
    if (!renamedSource) throw new Error("Fixture has no screenshot.");
    await copyFile(path.join(renamedRoot, renamedSource), path.join(renamedRoot, "hidden.bin"));
    await assert.rejects(validateEvidenceBundle(renamedRoot), /unreferenced PNG screenshot/u);

    const linkedRoot = await clonedEvidence();
    const linkedManifest = await readJson<MutableManifest>(path.join(linkedRoot, "manifest.json"));
    const linkedRelative = linkedManifest.runs[0]?.screenshots[0]?.relativePath;
    if (!linkedRelative) throw new Error("Fixture has no screenshot.");
    const linkedAbsolute = path.join(linkedRoot, linkedRelative);
    const outside = path.join(path.dirname(linkedRoot), "outside.png");
    await copyFile(linkedAbsolute, outside);
    await unlink(linkedAbsolute);
    await symlink(outside, linkedAbsolute);
    await assert.rejects(validateEvidenceBundle(linkedRoot), /Evidence cannot contain symlink/u);
  });

  it("requires discovery summaries to carry their complete evidence refs", async () => {
    const root = await clonedEvidence();
    const manifestPath = path.join(root, "manifest.json");
    const manifest = await readJson<MutableManifest>(manifestPath);
    const discovery = manifest.runs[0];
    if (!discovery) throw new Error("Fixture has no discovery run.");
    const summaryPath = path.join(root, discovery.summary);
    const summary = await readJson<MutableSummary>(summaryPath);
    delete summary.evidence;
    await writeJson(summaryPath, summary);
    discovery.summarySha256 = digest(await readFile(summaryPath));
    await writeJson(manifestPath, manifest);

    await assert.rejects(validateEvidenceBundle(root));
  });
});

const PNG_HEADER_BYTES = 8;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
