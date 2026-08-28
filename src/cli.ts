import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createDemoBinding, createDemoPolicyStack, DEMO_GOAL, DEMO_INPUTS } from "./demo/config.js";
import {
  createDemoDiscoveryRequest,
  DEMO_ARTIFACT_SPEC,
  DEMO_REPLAY_SENTINELS,
} from "./demo/spec.js";
import {
  type ArtifactApproval,
  type AutomationFault,
  type CapabilityArtifact,
  CapabilityArtifactSchema,
  type InterventionView,
  type RunResult,
} from "./domain/schema.js";
import {
  type DiscoveryPlanner,
  OllamaPlanner,
  OpenAiCompatiblePlanner,
  ScriptedPlanner,
} from "./model/planner.js";
import {
  type OperatorActionAuthorizer,
  type OperatorConsoleHandle,
  type OperatorResumeResult,
  startOperatorConsole,
} from "./operator/index.js";
import { ControlCoordinator } from "./runtime/control.js";
import {
  DiscoveryEngine,
  type DiscoveryRequest,
  type DiscoveryResult,
} from "./runtime/discovery.js";
import {
  type EvidenceKind,
  type EvidenceRef,
  EvidenceWriter,
  safeFaultDiagnostic,
} from "./runtime/evidence.js";
import { checkPolicy, type RuntimeCommand } from "./runtime/policy.js";
import { classified, redactValue } from "./runtime/redaction.js";
import { ReplayEngine } from "./runtime/replay.js";
import { BrowserSurface } from "./surface/browser-surface.js";
import {
  type LegacyScenario,
  type LegacyTargetHandle,
  startLegacyTarget,
} from "./target/server.js";

const COMMANDS = new Set(["catalog", "demo", "discover", "replay", "serve"]);
const SCENARIOS = new Set<LegacyScenario>([
  "normal",
  "notice",
  "slow",
  "session-expired",
  "ambiguous",
  "off-origin",
]);
const KNOWN_OPTIONS = new Set([
  "artifact",
  "artifact-approval",
  "goal",
  "headless",
  "headed",
  "handoff",
  "help",
  "include-screenshot",
  "json",
  "member-id",
  "once",
  "operator-port",
  "output",
  "planner",
  "port",
  "replay-member-id",
  "replays",
  "run-id",
  "scenario",
  "screenshots-safe",
  "source-revision",
  "target",
  "target-only",
  "target-port",
]);

type Command = "catalog" | "demo" | "discover" | "replay" | "serve";
type PlannerMode = "scripted" | "live";

export interface CliIo {
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly now: () => Date;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

interface ParsedArguments {
  readonly command?: Command;
  readonly options: ReadonlyMap<string, string | true>;
  readonly positionals: readonly string[];
}

interface ManagedTarget {
  readonly origin: string;
  readonly entryUrl: string;
  readonly synthetic: boolean;
  readonly close: () => Promise<void>;
}

interface RunEvidence {
  readonly id: string;
  readonly kind: "discovery" | "replay";
  readonly scenario: "success" | "exception" | "handoff";
  readonly directory: string;
  readonly summary: string;
  readonly summarySha256: string;
  readonly events: string;
  readonly eventsSha256: string;
  readonly screenshots: readonly ScreenshotEvidenceRef[];
}

interface HandoffEvidenceSummary {
  readonly interventionId: string;
  readonly reason: InterventionView["reason"];
  readonly originalSessionId: string;
  readonly resumedSessionId: string;
  readonly sameSession: true;
  readonly automationEpochBefore: number;
  readonly operatorEpoch: number;
  readonly automationEpochAfter: number;
  readonly checkpointPassed: true;
  readonly operatorAuditEvents: number;
  readonly evidence: readonly EvidenceRef[];
}

interface ScreenshotEvidenceRef {
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mimeType: "image/png";
}

interface ModelEvidence {
  readonly provider: string;
  readonly modelId: string;
  readonly liveModel: boolean;
  readonly digest?: string;
}

interface RuntimeProvenance {
  readonly sourceRevision: string;
  readonly sourceTreeSha256: string;
  readonly targetFixtureSha256: string;
  readonly nodeVersion: string;
  readonly playwrightVersion: string;
  readonly invocation: {
    readonly command: "demo:offline" | "demo:live";
    readonly planner: PlannerMode;
    readonly replayRuns: number;
    readonly screenshotModelInput: boolean;
    readonly syntheticTarget: boolean;
  };
}

interface StabilityRun {
  readonly runId: string;
  readonly status: RunResult["status"];
  readonly durationMs: number;
  readonly modelCalls: number;
}

export class CliEvidenceWriter extends EvidenceWriter {
  override async writeJson(
    relativePath: string,
    value: unknown,
    kind: EvidenceKind = "summary",
  ): Promise<EvidenceRef> {
    if (kind !== "artifact") return super.writeJson(relativePath, value, kind);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    return this.writeImmutableBytes(relativePath, bytes, "artifact", "application/json");
  }
}

const defaultIo: CliIo = {
  cwd: process.cwd(),
  env: process.env,
  now: () => new Date(),
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function parseArguments(argv: readonly string[]): ParsedArguments {
  const tokens = [...argv];
  const first = tokens.shift();
  const command = first && COMMANDS.has(first) ? (first as Command) : undefined;
  if (first && !command && first !== "--help" && first !== "-h") {
    throw new Error(`Unknown command ${first}.`);
  }
  if (first === "--help" || first === "-h") tokens.unshift("--help");

  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "-h") {
      options.set("help", true);
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    const name = token.slice(2, separator < 0 ? undefined : separator);
    if (!KNOWN_OPTIONS.has(name)) throw new Error(`Unknown option --${name}.`);
    if (separator >= 0) {
      const value = token.slice(separator + 1);
      if (!value) throw new Error(`Option --${name} requires a value.`);
      options.set(name, value);
      continue;
    }
    const next = tokens[index + 1];
    if (next && !next.startsWith("-")) {
      options.set(name, next);
      index += 1;
    } else {
      options.set(name, true);
    }
  }
  return { ...(command ? { command } : {}), options, positionals };
}

function option(args: ParsedArguments, name: string): string | undefined {
  const value = args.options.get(name);
  if (value === true) throw new Error(`Option --${name} requires a value.`);
  return value;
}

function flag(args: ParsedArguments, name: string): boolean {
  return args.options.get(name) === true;
}

function integerOption(
  args: ParsedArguments,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`Invalid boolean value ${value}.`);
}

function headless(args: ParsedArguments, env: Readonly<NodeJS.ProcessEnv>): boolean {
  if (flag(args, "headed")) return false;
  if (flag(args, "headless")) return true;
  return parseBoolean(env.HANDRAIL_HEADLESS, true);
}

function plannerMode(args: ParsedArguments): PlannerMode {
  const value = option(args, "planner") ?? "live";
  if (value !== "scripted" && value !== "live") {
    throw new Error("--planner must be scripted or live.");
  }
  return value;
}

function discoveryGoal(args: ParsedArguments): string {
  const value = (option(args, "goal") ?? DEMO_GOAL).trim();
  if (value.length === 0 || value.length > 500) {
    throw new Error("--goal must contain between 1 and 500 characters.");
  }
  return value;
}

function safeRunBase(value: string): string {
  const normalized = value
    .replaceAll(/[^A-Za-z0-9._-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 90);
  const prefixed = /^[A-Za-z]/u.test(normalized) ? normalized : `run-${normalized || "demo"}`;
  return prefixed.length >= 2 ? prefixed : "run-demo";
}

function timestampId(now: Date): string {
  return now
    .toISOString()
    .replaceAll(/[-:.TZ]/gu, "")
    .slice(0, 14);
}

function runBase(args: ParsedArguments, io: CliIo, prefix: string): string {
  return safeRunBase(
    option(args, "run-id") ?? io.env.HANDRAIL_RUN_ID ?? `${prefix}-${timestampId(io.now())}`,
  );
}

function absoluteOutput(args: ParsedArguments, io: CliIo, fallback: string): string {
  const configured = option(args, "output") ?? io.env.HANDRAIL_EVIDENCE_DIR ?? fallback;
  const resolved = path.resolve(io.cwd, configured);
  if (resolved === path.resolve(io.cwd)) {
    throw new Error("The evidence output cannot be the repository root.");
  }
  return resolved;
}

async function treeSha256(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`Runtime source contains unsupported entry ${absolute}.`);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      hash.update(relative, "utf8");
      hash.update("\0", "utf8");
      hash.update(await readFile(absolute));
      hash.update("\0", "utf8");
    }
  };
  await visit(root);
  return hash.digest("hex");
}

async function installedPackageVersion(root: string, packageName: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(root, "node_modules", packageName, "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`Installed ${packageName} package does not declare a version.`);
  }
  return manifest.version;
}

async function runtimeProvenance(
  args: ParsedArguments,
  io: CliIo,
  mode: PlannerMode,
  target: ManagedTarget,
  replayRuns: number,
): Promise<RuntimeProvenance> {
  const sourceRevision = option(args, "source-revision") ?? "working-tree";
  if (sourceRevision !== "working-tree" && !/^[a-f0-9]{40}$/u.test(sourceRevision)) {
    throw new Error(
      "--source-revision must be a lowercase 40-character Git commit or working-tree.",
    );
  }
  return {
    sourceRevision,
    sourceTreeSha256: await treeSha256(path.join(io.cwd, "src")),
    targetFixtureSha256: await treeSha256(path.join(io.cwd, "src", "target")),
    nodeVersion: process.version,
    playwrightVersion: await installedPackageVersion(io.cwd, "playwright"),
    invocation: {
      command: mode === "live" ? "demo:live" : "demo:offline",
      planner: mode,
      replayRuns,
      screenshotModelInput: flag(args, "include-screenshot"),
      syntheticTarget: target.synthetic,
    },
  };
}

function scenario(args: ParsedArguments): LegacyScenario {
  const value = option(args, "scenario") ?? "normal";
  if (!SCENARIOS.has(value as LegacyScenario)) {
    throw new Error(`Unknown synthetic scenario ${value}.`);
  }
  return value as LegacyScenario;
}

function operatorCommand(
  action: Parameters<OperatorActionAuthorizer>[0]["action"],
): RuntimeCommand {
  switch (action) {
    case "activate_coordinate":
      return "activate";
    case "type":
      return "set_value";
    case "press_key":
      return "press_key";
    case "capture_evidence":
      return "capture_evidence";
  }
}

function demoOperatorAuthorizer(
  binding: ReturnType<typeof createDemoBinding>,
  targetUrl: string,
): OperatorActionAuthorizer {
  const base = createDemoPolicyStack(binding);
  const operatorPolicy = {
    platform: {
      ...base.platform,
      allowedEffects: ["read", "reversible_write", "commit"] as const,
    },
    binding: {
      ...base.binding,
      allowedEffects: ["read", "reversible_write", "commit"] as const,
    },
    capability: {
      name: "operator-handoff",
      allowedRoutes: ["/legacy", "/legacy/**"],
      allowedCommands: ["activate", "set_value", "press_key", "capture_evidence"] as const,
      allowedEffects: ["read", "reversible_write", "commit"] as const,
      approvalRequiredFor: ["commit"] as const,
    },
  };
  return (context) => {
    const decision = checkPolicy(operatorPolicy, {
      url: targetUrl,
      command: operatorCommand(context.action),
      effect: context.effect,
      actor: "operator",
      runId: context.runId,
      sessionId: context.sessionId,
      ownerEpoch: context.ownerEpoch,
      humanGrant: {
        id: `human-${context.operatorId}`,
        runId: context.runId,
        sessionId: context.sessionId,
        ownerEpoch: context.ownerEpoch,
        expiresAt: context.operatorLeaseExpiresAt,
      },
      now: context.requestedAt,
    });
    return decision.allowed
      ? { allowed: true, authorization: decision.authorization }
      : { allowed: false, code: decision.code, summary: decision.summary };
  };
}

function createPlanner(
  mode: PlannerMode,
  args: ParsedArguments,
  env: Readonly<NodeJS.ProcessEnv>,
): DiscoveryPlanner {
  if (mode === "scripted") return new ScriptedPlanner();
  const provider = env.HANDRAIL_PLANNER_PROVIDER ?? "ollama";
  const includeScreenshot = flag(args, "include-screenshot")
    ? true
    : parseBoolean(env.HANDRAIL_INCLUDE_SCREENSHOT, false);
  const timeoutMs = Number(env.HANDRAIL_MODEL_TIMEOUT_MS ?? "45000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw new Error("HANDRAIL_MODEL_TIMEOUT_MS must be between 1000 and 600000.");
  }
  if (provider === "ollama") {
    return new OllamaPlanner({
      baseUrl:
        env.HANDRAIL_OLLAMA_BASE_URL ??
        env.OLLAMA_BASE_URL ??
        env.OLLAMA_HOST ??
        "http://127.0.0.1:11434",
      model: env.HANDRAIL_MODEL ?? env.OLLAMA_MODEL ?? "qwen3:4b",
      includeScreenshot,
      timeoutMs,
    });
  }
  if (provider === "openai-compatible") {
    const baseUrl = env.LLM_BASE_URL;
    const model = env.LLM_MODEL;
    if (!baseUrl || !model) {
      throw new Error("openai-compatible live mode requires LLM_BASE_URL and LLM_MODEL.");
    }
    return new OpenAiCompatiblePlanner({
      baseUrl,
      apiKey: env.LLM_API_KEY ?? "local-only",
      model,
      providerName: env.HANDRAIL_PROVIDER_NAME ?? "openai-compatible-local",
      includeScreenshot,
      allowRemoteDataEgress: parseBoolean(env.HANDRAIL_ALLOW_REMOTE_MODEL_EGRESS, false),
      timeoutMs,
    });
  }
  throw new Error("HANDRAIL_PLANNER_PROVIDER must be ollama or openai-compatible.");
}

async function resolvedModelEvidence(
  provenance: CapabilityArtifact["provenance"],
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<ModelEvidence> {
  const base: ModelEvidence = {
    provider: provenance.provider,
    modelId: provenance.modelId,
    liveModel: provenance.liveModel,
  };
  if (provenance.provider !== "ollama-local") return base;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const origin = (
      env.HANDRAIL_OLLAMA_BASE_URL ??
      env.OLLAMA_BASE_URL ??
      env.OLLAMA_HOST ??
      "http://127.0.0.1:11434"
    ).replace(/\/$/u, "");
    const response = await fetch(`${origin}/api/tags`, { signal: controller.signal });
    if (!response.ok) return base;
    const payload = (await response.json()) as {
      models?: Array<{ name?: string; model?: string; digest?: string }>;
    };
    const match = payload.models?.find(
      (item) => item.name === provenance.modelId || item.model === provenance.modelId,
    );
    return match?.digest ? { ...base, digest: match.digest } : base;
  } catch {
    return base;
  } finally {
    clearTimeout(timeout);
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function stabilityReport(artifact: CapabilityArtifact, runs: readonly StabilityRun[]) {
  const latencies = runs.map((run) => run.durationMs).sort((left, right) => left - right);
  const succeeded = runs.filter((run) => run.status === "succeeded").length;
  const mean =
    latencies.length === 0
      ? 0
      : Number(
          (latencies.reduce((total, duration) => total + duration, 0) / latencies.length).toFixed(
            2,
          ),
        );
  return {
    schemaVersion: "1.0.0",
    artifactId: artifact.id,
    artifactDigest: artifact.digest,
    requestedRuns: runs.length,
    completedRuns: runs.length,
    succeeded,
    successRate: runs.length === 0 ? 0 : Number((succeeded / runs.length).toFixed(4)),
    allZeroModelCalls: runs.every((run) => run.modelCalls === 0),
    totalModelCalls: runs.reduce((total, run) => total + run.modelCalls, 0),
    latencyMs: {
      min: latencies[0] ?? 0,
      max: latencies.at(-1) ?? 0,
      mean,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    runs,
  };
}

async function managedTarget(args: ParsedArguments, defaultPort = 0): Promise<ManagedTarget> {
  const supplied = option(args, "target");
  if (supplied) {
    const url = new URL(supplied);
    if (!(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:")) {
      throw new Error("--target must use HTTP or HTTPS.");
    }
    if (url.pathname !== "/legacy") {
      throw new Error("The demo binding currently supports the /legacy entrypoint only.");
    }
    url.hash = "";
    return {
      origin: url.origin,
      entryUrl: url.toString(),
      synthetic: flag(args, "screenshots-safe"),
      close: async () => undefined,
    };
  }
  const port = integerOption(args, "target-port", defaultPort, 0, 65_535);
  const target = await startLegacyTarget({ port });
  return {
    origin: target.origin,
    entryUrl: target.entryUrl(scenario(args)),
    synthetic: true,
    close: target.close,
  };
}

function projectedOutputs(
  outputs: Readonly<Record<string, unknown>>,
  specifications: CapabilityArtifact["contract"]["outputs"] | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(outputs).map(([name, value]) => {
      const specification = specifications?.[name];
      // Undeclared outputs fail closed. Valid successful runs always have a matching spec.
      const classification = specification?.classification ?? "secret";
      return [name, redactValue(classified(value, classification))];
    }),
  );
}

function projectedIntervention(intervention: InterventionView): Record<string, unknown> {
  return {
    id: intervention.id,
    runId: intervention.runId,
    sessionId: intervention.sessionId,
    reason: intervention.reason,
    summary: "Human intervention details omitted from persistent evidence.",
    ...(intervention.currentStepId ? { currentStepId: intervention.currentStepId } : {}),
    observedState: "Surface details omitted from persistent evidence.",
    allowedActions: intervention.allowedActions,
    evidence: intervention.evidence,
    ownerEpoch: intervention.ownerEpoch,
    createdAt: intervention.createdAt,
  };
}

function projectedFault(error: AutomationFault): Record<string, unknown> {
  return {
    code: error.code,
    message: "Failure details omitted from persistent evidence.",
    phase: error.phase,
    retryable: error.retryable,
    ...(error.stepId ? { stepId: error.stepId } : {}),
    diagnostic: safeFaultDiagnostic(error.code),
    evidence: error.evidence,
  };
}

export function discoverySummary(result: DiscoveryResult): Record<string, unknown> {
  return {
    kind: "discovery",
    status: result.status,
    runId: result.runId,
    sessionId: result.sessionId,
    modelCalls: result.modelCalls,
    recoveries: result.recoveries,
    evidence: result.evidence,
    ...(result.status === "succeeded"
      ? {
          artifactId: result.artifact.id,
          artifactDigest: result.artifact.digest,
          provenance: result.artifact.provenance,
          outputs: projectedOutputs(result.outputs, result.artifact.contract.outputs),
        }
      : {}),
    ...(result.status === "business_outcome" ? { outcome: result.outcome } : {}),
    ...(result.status === "needs_intervention"
      ? { intervention: projectedIntervention(result.intervention) }
      : {}),
    ...(result.status === "failed" ? { error: projectedFault(result.error) } : {}),
  };
}

export function projectRunResultForSummary(
  result: RunResult,
  artifact: CapabilityArtifact | undefined,
): Record<string, unknown> {
  if (result.status === "succeeded") {
    return {
      ...result,
      outputs: projectedOutputs(result.outputs, artifact?.contract.outputs),
    };
  }
  if (result.status === "needs_intervention") {
    return { ...result, intervention: projectedIntervention(result.intervention) };
  }
  if (result.status === "failed") {
    return { ...result, error: projectedFault(result.error) };
  }
  return result;
}

export function replaySummary(
  scenarioName: "success" | "exception" | "handoff",
  result: RunResult,
  artifact: CapabilityArtifact | undefined,
  handoff?: HandoffEvidenceSummary,
) {
  return {
    kind: "replay",
    scenario: scenarioName,
    result: projectRunResultForSummary(result, artifact),
    ...(handoff ? { handoff } : {}),
  };
}

async function writeDiscoverySummary(
  writer: EvidenceWriter,
  result: DiscoveryResult,
): Promise<{ summary: EvidenceRef; events: EvidenceRef }> {
  const summary = await writer.writeJson("summary.json", discoverySummary(result));
  const events = await writer.eventLogRef();
  return { summary, events };
}

async function writeReplaySummary(
  writer: EvidenceWriter,
  scenarioName: "success" | "exception" | "handoff",
  result: RunResult,
  artifact: CapabilityArtifact | undefined,
  handoff?: HandoffEvidenceSummary,
): Promise<{ summary: EvidenceRef; events: EvidenceRef }> {
  const summary = await writer.writeJson(
    "summary.json",
    replaySummary(scenarioName, result, artifact, handoff),
  );
  const events = await writer.eventLogRef();
  return { summary, events };
}

function manifestRun(
  root: string,
  id: string,
  kind: RunEvidence["kind"],
  scenarioName: RunEvidence["scenario"],
  summary: EvidenceRef,
  events: EvidenceRef,
  screenshotRefs: readonly EvidenceRef[],
): RunEvidence {
  const directory = `runs/${id}`;
  const relative = (ref: EvidenceRef) => path.posix.join(directory, ref.relativePath);
  const screenshots = screenshotRefs.map((ref): ScreenshotEvidenceRef => {
    if (ref.kind !== "screenshot" || ref.mimeType !== "image/png") {
      throw new TypeError("Demo screenshot evidence must be a PNG screenshot ref.");
    }
    return {
      relativePath: relative(ref),
      sha256: ref.sha256,
      byteLength: ref.byteLength,
      mimeType: "image/png",
    };
  });
  return {
    id,
    kind,
    scenario: scenarioName,
    directory: path.relative(root, path.join(root, directory)).split(path.sep).join("/"),
    summary: relative(summary),
    summarySha256: summary.sha256,
    events: relative(events),
    eventsSha256: events.sha256,
    screenshots,
  };
}

function screenshotRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return refs.filter((ref) => ref.kind === "screenshot");
}

function replayScreenshotRefs(result: RunResult): readonly EvidenceRef[] {
  switch (result.status) {
    case "succeeded":
      return screenshotRefs(result.checkpointEvidence);
    case "business_outcome":
      return screenshotRefs(result.evidence);
    case "needs_intervention":
      return screenshotRefs(result.intervention.evidence);
    case "failed":
      return screenshotRefs(result.error.evidence);
  }
}

function exitForResult(result: DiscoveryResult | RunResult): number {
  if (result.status === "succeeded" || result.status === "business_outcome") return 0;
  return result.status === "needs_intervention" ? 2 : 1;
}

async function runDiscovery(args: ParsedArguments, io: CliIo, mode: PlannerMode): Promise<number> {
  const id = runBase(args, io, mode === "live" ? "discovery-live" : "discovery-scripted");
  const fallback = path.join(mode === "live" ? "evidence/.staging" : "work", id);
  const output = absoluteOutput(args, io, fallback);
  const target = await managedTarget(args);
  const control = new ControlCoordinator();
  const surface = await BrowserSurface.launch({ control, headless: headless(args, io.env) });
  let operator: OperatorConsoleHandle | undefined;
  let handoffInterrupted = false;
  try {
    const binding = createDemoBinding(target.origin);
    const planner = createPlanner(mode, args, io.env);
    const writer = new CliEvidenceWriter({ rootDirectory: output });
    const baseRequest = createDemoDiscoveryRequest(binding, target.entryUrl, {
      goal: discoveryGoal(args),
      runId: id,
      artifactEvidencePath: "artifact.json",
      ...(target.synthetic
        ? { persistObservationScreenshots: true, screenshotsRedactionVerified: true }
        : {}),
    });
    const memberId = option(args, "member-id") ?? DEMO_INPUTS.memberId;
    const request: DiscoveryRequest = { ...baseRequest, inputs: { memberId } };
    if (flag(args, "handoff")) {
      operator = await startOperatorConsole({
        control,
        surface,
        port: integerOption(args, "operator-port", 4313, 0, 65_535),
        authorizeOperatorAction: demoOperatorAuthorizer(binding, target.entryUrl),
        auditSink: (event) => writer.appendEvent(event),
        ...(target.synthetic
          ? {
              captureSink: (capture) =>
                writer.writeScreenshot(`screenshots/${capture.id}.png`, capture.screenshotPng, {
                  redactionVerified: true,
                  mimeType: capture.mimeType,
                }),
            }
          : {}),
      });
    }
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control,
      policy: createDemoPolicyStack(binding),
      evidence: writer,
      ...(operator
        ? {
            onIntervention: async (context) => {
              if (!operator) throw new Error("Operator console is unavailable.");
              const intervention = await operator.openIntervention({
                runId: context.runId,
                capability: context.capabilityId,
                currentStep: "discovery-loop",
                reason: context.reason,
                stoppedBecause: context.summary,
                session: context.session,
                automationGrant: context.automationGrant,
                automationId: context.runId,
                evaluateCheckpoint: async ({ session, observation }) => {
                  const blocked = /Your session has expired/iu.test(observation.visibleText);
                  const findMemberVisible = observation.elements.some(
                    (element) => element.role === "button" && element.name === "Find Member",
                  );
                  return {
                    passed: session.id === context.session.id && !blocked && findMemberVisible,
                    observed: blocked
                      ? "The session-expiry dialog still blocks discovery."
                      : findMemberVisible
                        ? "The same session is restored and Find Member is visible."
                        : "The session changed to an unknown state.",
                  };
                },
              });
              io.stdout(
                `${JSON.stringify({
                  kind: "intervention",
                  phase: "discovery",
                  state: "AWAITING_OPERATOR",
                  runId: context.runId,
                  sessionId: intervention.sessionId,
                  reason: context.reason,
                  operator: operator.origin,
                  intervention: intervention.url,
                })}\n`,
              );
              const resumed = await waitForResumeOrShutdown(intervention.waitForResume);
              if (!resumed) {
                handoffInterrupted = true;
                throw new Error("Discovery handoff was interrupted by shutdown.");
              }
              return resumed;
            },
          }
        : {}),
    }).discover(request);
    if (handoffInterrupted) return 0;
    await writeDiscoverySummary(writer, result);
    io.stdout(`${JSON.stringify({ output, result: discoverySummary(result) }, null, 2)}\n`);
    return exitForResult(result);
  } finally {
    await closeBrowserCommandResources(
      operator ?? { close: async () => undefined },
      surface,
      target,
    );
  }
}

async function runReplay(args: ParsedArguments, io: CliIo): Promise<number> {
  const id = runBase(args, io, "replay");
  const output = absoluteOutput(args, io, path.join("work", id));
  const artifactPath = path.resolve(
    io.cwd,
    option(args, "artifact") ?? "evidence/artifacts/member.balance.lookup.v1.json",
  );
  const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as unknown;
  const artifactApprovalPath = option(args, "artifact-approval");
  const artifactApproval = artifactApprovalPath
    ? (JSON.parse(await readFile(path.resolve(io.cwd, artifactApprovalPath), "utf8")) as unknown)
    : undefined;
  const parsedArtifact = CapabilityArtifactSchema.safeParse(artifact);
  const summaryArtifact = parsedArtifact.success ? parsedArtifact.data : undefined;
  const target = await managedTarget(args);
  const control = new ControlCoordinator();
  const surface = await BrowserSurface.launch({ control, headless: headless(args, io.env) });
  let operator: OperatorConsoleHandle | undefined;
  let handoffInterrupted = false;
  const operatorEvidence: EvidenceRef[] = [];
  let handoffSummary: HandoffEvidenceSummary | undefined;
  try {
    const binding = createDemoBinding(target.origin);
    const writer = new CliEvidenceWriter({ rootDirectory: output });
    if (flag(args, "handoff")) {
      operator = await startOperatorConsole({
        control,
        surface,
        port: integerOption(args, "operator-port", 4313, 0, 65_535),
        authorizeOperatorAction: demoOperatorAuthorizer(binding, target.entryUrl),
        auditSink: (event) => writer.appendEvent(event),
        ...(target.synthetic
          ? {
              captureSink: (capture) =>
                writer
                  .writeScreenshot(`screenshots/${capture.id}.png`, capture.screenshotPng, {
                    redactionVerified: true,
                    mimeType: capture.mimeType,
                  })
                  .then((ref) => {
                    operatorEvidence.push(ref);
                    return ref;
                  }),
            }
          : {}),
      });
    }
    const result = await new ReplayEngine({
      surface,
      control,
      platformPolicy: createDemoPolicyStack(binding).platform,
      evidence: writer,
      screenshotRedactionVerified: target.synthetic,
      surfaceSentinels: DEMO_REPLAY_SENTINELS,
      artifactApprovalMode: artifactApproval === undefined ? "non_strict" : "strict",
      ...(operator
        ? {
            onIntervention: async (context) => {
              if (!operator) throw new Error("Operator console is unavailable.");
              const intervention = await operator.openIntervention({
                runId: context.runId,
                capability: context.artifactId,
                currentStep: context.currentStepId,
                reason: context.reason,
                stoppedBecause: `${context.summary} Observed: ${context.observedState}`,
                session: context.session,
                automationGrant: context.automationGrant,
                automationId: context.runId,
                evaluateCheckpoint: async ({ session, observation }) => {
                  const blocked = /Your session has expired/iu.test(observation.visibleText);
                  const findMemberVisible = observation.elements.some(
                    (element) => element.role === "button" && element.name === "Find Member",
                  );
                  return {
                    passed: session.id === context.session.id && !blocked && findMemberVisible,
                    observed: blocked
                      ? "The session-expiry dialog still blocks replay."
                      : findMemberVisible
                        ? "The same session is restored and Find Member is visible."
                        : "The dialog cleared, but Find Member is not visible in the same session.",
                  };
                },
              });
              io.stdout(
                `${JSON.stringify({
                  kind: "intervention",
                  state: "AWAITING_OPERATOR",
                  runId: context.runId,
                  sessionId: intervention.sessionId,
                  reason: context.reason,
                  operator: operator.origin,
                  intervention: intervention.url,
                })}\n`,
              );
              const resumed = await waitForResumeOrShutdown(intervention.waitForResume);
              if (!resumed) {
                handoffInterrupted = true;
                throw new Error("Replay handoff was interrupted by shutdown.");
              }
              const audit = intervention.audit();
              const operatorEpoch = audit.find(
                (event) => event.action === "control_claimed",
              )?.ownerEpoch;
              if (
                resumed.sessionId !== context.session.id ||
                !resumed.checkpoint.passed ||
                operatorEpoch === undefined
              ) {
                throw new Error("Replay handoff resumed without complete same-session evidence.");
              }
              handoffSummary = {
                interventionId: `handoff-${context.runId}`,
                reason: context.reason,
                originalSessionId: context.session.id,
                resumedSessionId: resumed.sessionId,
                sameSession: true,
                automationEpochBefore: context.automationGrant.epoch,
                operatorEpoch,
                automationEpochAfter: resumed.automationGrant.epoch,
                checkpointPassed: true,
                operatorAuditEvents: audit.length,
                evidence: [...operatorEvidence],
              };
              return resumed;
            },
          }
        : {}),
    }).run({
      artifact,
      binding,
      inputs: { memberId: option(args, "member-id") ?? "26017" },
      targetUrl: target.entryUrl,
      runId: id,
      ...(artifactApproval === undefined ? {} : { artifactApproval }),
    });
    if (handoffInterrupted) return 0;
    await writeReplaySummary(
      writer,
      handoffSummary ? "handoff" : result.status === "succeeded" ? "success" : "exception",
      result,
      summaryArtifact,
      handoffSummary,
    );
    io.stdout(
      `${JSON.stringify(
        {
          output,
          result: projectRunResultForSummary(result, summaryArtifact),
          ...(result.status === "needs_intervention" && !operator
            ? {
                retainedSession: false,
                guidance:
                  "Re-run with --handoff to open a same-session operator console, or use serve --scenario session-expired for the evaluator demo.",
              }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
    return exitForResult(result);
  } finally {
    await closeBrowserCommandResources(
      operator ?? { close: async () => undefined },
      surface,
      target,
    );
  }
}

async function replayForDemo(
  root: string,
  id: string,
  scenarioName: "success" | "exception",
  memberId: string,
  artifact: CapabilityArtifact,
  artifactApproval: ArtifactApproval,
  target: ManagedTarget,
  surface: BrowserSurface,
  control: ControlCoordinator,
): Promise<{ result: RunResult; evidence: RunEvidence }> {
  const directory = path.join(root, "runs", id);
  const writer = new CliEvidenceWriter({ rootDirectory: directory });
  const binding = createDemoBinding(target.origin);
  const result = await new ReplayEngine({
    surface,
    control,
    platformPolicy: createDemoPolicyStack(binding).platform,
    evidence: writer,
    screenshotRedactionVerified: target.synthetic,
    surfaceSentinels: DEMO_REPLAY_SENTINELS,
    artifactApprovalMode: "strict",
  }).run({ artifact, artifactApproval, binding, inputs: { memberId }, runId: id });
  const refs = await writeReplaySummary(writer, scenarioName, result, artifact);
  return {
    result,
    evidence: manifestRun(
      root,
      id,
      "replay",
      scenarioName,
      refs.summary,
      refs.events,
      replayScreenshotRefs(result),
    ),
  };
}

async function runDemo(args: ParsedArguments, io: CliIo, mode: PlannerMode): Promise<number> {
  const base = runBase(args, io, mode === "live" ? "demo-live" : "demo-scripted");
  const output = absoluteOutput(args, io, path.join("work", base));
  const target = await managedTarget(args);
  const control = new ControlCoordinator();
  const surface = await BrowserSurface.launch({ control, headless: headless(args, io.env) });
  try {
    const binding = createDemoBinding(target.origin);
    const discoveryId = `${base}-discovery`;
    const discoveryDirectory = path.join(output, "runs", discoveryId);
    const discoveryWriter = new CliEvidenceWriter({ rootDirectory: discoveryDirectory });
    const discovery = await new DiscoveryEngine({
      surface,
      planner: createPlanner(mode, args, io.env),
      control,
      policy: createDemoPolicyStack(binding),
      evidence: discoveryWriter,
    }).discover(
      createDemoDiscoveryRequest(binding, target.entryUrl, {
        goal: discoveryGoal(args),
        runId: discoveryId,
        artifactEvidencePath: "artifact.json",
        ...(target.synthetic
          ? { persistObservationScreenshots: true, screenshotsRedactionVerified: true }
          : {}),
      }),
    );
    const discoveryRefs = await writeDiscoverySummary(discoveryWriter, discovery);
    if (discovery.status !== "succeeded") {
      io.stdout(`${JSON.stringify({ output, discovery: discoverySummary(discovery) }, null, 2)}\n`);
      return exitForResult(discovery);
    }

    const rootWriter = new CliEvidenceWriter({ rootDirectory: output });
    const artifactRef = await rootWriter.writeJson(
      "artifacts/member.balance.lookup.v1.json",
      discovery.artifact,
      "artifact",
    );
    const artifactApproval: ArtifactApproval = {
      artifactId: discovery.artifact.id,
      revision: discovery.artifact.revision,
      digest: discovery.artifact.digest,
      approvedBy: "local-evaluator",
      approvedAt: io.now().toISOString(),
    };
    const artifactApprovalRef = await rootWriter.writeJson(
      "artifacts/member.balance.lookup.v1.approval.json",
      artifactApproval,
      "artifact",
    );
    const replayCount = integerOption(args, "replays", 1, 1, 50);
    const replaySuccesses: Array<Awaited<ReturnType<typeof replayForDemo>>> = [];
    for (let index = 0; index < replayCount; index += 1) {
      const suffix = replayCount === 1 ? "" : `-${String(index + 1).padStart(2, "0")}`;
      replaySuccesses.push(
        await replayForDemo(
          output,
          `${base}-replay-success${suffix}`,
          "success",
          option(args, "replay-member-id") ?? "26017",
          discovery.artifact,
          artifactApproval,
          target,
          surface,
          control,
        ),
      );
    }
    const replayExceptionId = `${base}-replay-not-found`;
    const replayException = await replayForDemo(
      output,
      replayExceptionId,
      "exception",
      "99999",
      discovery.artifact,
      artifactApproval,
      target,
      surface,
      control,
    );
    const runs: RunEvidence[] = [
      manifestRun(
        output,
        discoveryId,
        "discovery",
        "success",
        discoveryRefs.summary,
        discoveryRefs.events,
        screenshotRefs(discovery.evidence),
      ),
      ...replaySuccesses.map((run) => run.evidence),
      replayException.evidence,
    ];
    const stability = stabilityReport(
      discovery.artifact,
      replaySuccesses.map(({ result }) => ({
        runId: result.meta.runId,
        status: result.status,
        durationMs: result.meta.durationMs,
        modelCalls: result.meta.modelCalls,
      })),
    );
    const stabilityRef = await rootWriter.writeJson("stability.json", stability);
    const model = await resolvedModelEvidence(discovery.artifact.provenance, io.env);
    const provenance = await runtimeProvenance(args, io, mode, target, replayCount);
    await rootWriter.writeSanitizedText(
      "README.md",
      [
        "# Handrail evidence bundle",
        "",
        "Generated by the public demo command against the repository's synthetic legacy UI.",
        `The discovery run is model-driven; ${replayCount} stability replay run${replayCount === 1 ? "" : "s"} execute the compiled artifact with zero model calls.`,
        "The exceptional replay demonstrates the declared MEMBER_NOT_FOUND business outcome.",
      ].join("\n"),
    );
    await rootWriter.writeJson("manifest.json", {
      schemaVersion: "1.2.0",
      generatedAt: io.now().toISOString(),
      mode,
      model,
      provenance,
      artifact: artifactRef.relativePath,
      artifactSha256: artifactRef.sha256,
      artifactApproval: artifactApprovalRef.relativePath,
      artifactApprovalSha256: artifactApprovalRef.sha256,
      stability: { path: stabilityRef.relativePath, sha256: stabilityRef.sha256 },
      runs,
    });

    const okay =
      replaySuccesses.every((run) => run.result.status === "succeeded") &&
      stability.allZeroModelCalls &&
      replayException.result.status === "business_outcome";
    io.stdout(
      `${JSON.stringify(
        {
          status: okay ? "succeeded" : "failed",
          output,
          discovery: discoverySummary(discovery),
          model,
          stability,
          replayException: projectRunResultForSummary(replayException.result, discovery.artifact),
        },
        null,
        2,
      )}\n`,
    );
    return okay ? 0 : 1;
  } finally {
    await surface.close();
    await target.close();
  }
}

function catalog(io: CliIo, jsonOutput: boolean): number {
  const item = {
    id: DEMO_ARTIFACT_SPEC.id,
    revision: DEMO_ARTIFACT_SPEC.revision,
    name: DEMO_ARTIFACT_SPEC.name,
    purpose: DEMO_ARTIFACT_SPEC.purpose,
    goal: DEMO_GOAL,
    inputs: Object.keys(DEMO_ARTIFACT_SPEC.inputs),
    outputs: Object.keys(DEMO_ARTIFACT_SPEC.outputs),
    outcomes: (DEMO_ARTIFACT_SPEC.outcomes ?? []).map((outcome) => outcome.code),
    plannerModes: ["scripted", "live"],
  };
  if (jsonOutput) {
    io.stdout(`${JSON.stringify([item], null, 2)}\n`);
  } else {
    io.stdout(
      [
        "Handrail capability catalog",
        "",
        `${item.id}  rev ${item.revision}`,
        item.name,
        `Input: ${item.inputs.join(", ")}  Output: ${item.outputs.join(", ")}`,
        `Known outcome: ${item.outcomes.join(", ")}`,
        "",
      ].join("\n"),
    );
  }
  return 0;
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

async function waitForResumeOrShutdown(
  waitForResume: (signal?: AbortSignal) => Promise<OperatorResumeResult>,
): Promise<OperatorResumeResult | undefined> {
  const controller = new AbortController();
  let shutdown = false;
  const stop = () => {
    shutdown = true;
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return await waitForResume(controller.signal).catch((error: unknown) => {
      if (shutdown) return undefined;
      throw error;
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export function isPlaywrightAlreadyClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Target page, context or browser has been closed/iu.test(error.message)
  );
}

async function closeBrowserCommandResources(
  operator: { close: () => Promise<void> },
  surface: { close: () => Promise<void> },
  target: { close: () => Promise<void> },
): Promise<void> {
  const results = await Promise.allSettled([operator.close(), surface.close(), target.close()]);
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    if (index === 1 && isPlaywrightAlreadyClosedError(result.reason)) return [];
    return [result.reason];
  });
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Browser command resources failed to close.");
  }
}

async function seedExpiredSession(
  target: LegacyTargetHandle,
  surface: BrowserSurface,
  control: ControlCoordinator,
) {
  const binding = createDemoBinding(target.origin);
  const session = await surface.createSession(binding);
  const grant = control.createAutomationLease(session.id, "serve-handoff");
  await surface.navigate(session.id, target.entryUrl("session-expired"), grant);
  let observation = await surface.observe(session.id);
  const input = observation.elements.find(
    (element) =>
      element.role === "textbox" &&
      element.context.precedingLabel?.toLowerCase() === "member number",
  );
  if (!input) throw new Error("Could not seed handoff: Member number control is unavailable.");
  await surface.dispatch(
    session.id,
    {
      kind: "set_value",
      decisionId: "serve-fill-member",
      observationId: observation.id,
      rationale: "Seed the synthetic expired-session handoff scenario.",
      elementRef: input.ref,
      value: { kind: "input", name: "memberId" },
    },
    { observationId: observation.id, inputs: { memberId: "84721" }, grant },
  );
  observation = await surface.observe(session.id);
  const button = observation.elements.find(
    (element) => element.role === "button" && element.name === "Find Member",
  );
  if (!button) throw new Error("Could not seed handoff: Find Member control is unavailable.");
  await surface.dispatch(
    session.id,
    {
      kind: "activate",
      decisionId: "serve-open-expired",
      observationId: observation.id,
      rationale: "Trigger the deterministic synthetic session-expiry dialog.",
      elementRef: button.ref,
    },
    { observationId: observation.id, inputs: { memberId: "84721" }, grant },
  );
  observation = await surface.observe(session.id);
  if (!/Your session has expired/iu.test(observation.visibleText)) {
    throw new Error("Could not seed handoff: expected session-expiry dialog did not appear.");
  }
  return { session, grant, observation };
}

async function serve(args: ParsedArguments, io: CliIo): Promise<number> {
  const port = integerOption(args, "port", 4312, 0, 65_535);
  const target: LegacyTargetHandle = await startLegacyTarget({ port });
  if (flag(args, "target-only")) {
    io.stdout(
      `${JSON.stringify({ target: target.entryUrl(), health: `${target.origin}/health` })}\n`,
    );
    if (!flag(args, "once")) await waitForShutdown();
    await target.close();
    return 0;
  }

  const control = new ControlCoordinator();
  const surface = await BrowserSurface.launch({ control, headless: headless(args, io.env) });
  const operator = await startOperatorConsole({
    control,
    surface,
    port: integerOption(args, "operator-port", 4313, 0, 65_535),
    authorizeOperatorAction: demoOperatorAuthorizer(
      createDemoBinding(target.origin),
      target.entryUrl(scenario(args)),
    ),
  });
  try {
    if (scenario(args) === "session-expired") {
      const seeded = await seedExpiredSession(target, surface, control);
      const intervention = await operator.openIntervention({
        runId: "serve-handoff-demo",
        capability: DEMO_ARTIFACT_SPEC.id,
        currentStep: "activate-member-lookup",
        reason: "Session expired - manual recovery required",
        stoppedBecause: "Known session-timeout dialog detected on the live synthetic surface",
        session: seeded.session,
        automationGrant: seeded.grant,
        automationId: "serve-handoff",
        evaluateCheckpoint: async ({ observation }) => ({
          passed:
            !/Your session has expired/iu.test(observation.visibleText) &&
            /Synthetic session restored/iu.test(observation.visibleText),
          observed: /Synthetic session restored/iu.test(observation.visibleText)
            ? "Session restored in the original browser session"
            : "The session-expiry dialog still blocks automation",
        }),
      });
      io.stdout(
        `${JSON.stringify({
          target: target.entryUrl("session-expired"),
          health: `${target.origin}/health`,
          operator: operator.origin,
          intervention: intervention.url,
          sessionId: intervention.sessionId,
          state: "AWAITING_OPERATOR",
        })}\n`,
      );
      if (flag(args, "once")) return 0;
      const resumed = await waitForResumeOrShutdown(intervention.waitForResume);
      if (!resumed) return 0;
      const findMember = resumed.observation.elements.find(
        (element) => element.role === "button" && element.name === "Find Member",
      );
      if (!findMember) throw new Error("Resumed surface no longer exposes Find Member.");
      await surface.dispatch(
        resumed.sessionId,
        {
          kind: "activate",
          decisionId: "serve-resume-search",
          observationId: resumed.observation.id,
          rationale: "Continue the paused lookup after the human restored the same session.",
          elementRef: findMember.ref,
        },
        {
          observationId: resumed.observation.id,
          inputs: { memberId: "84721" },
          grant: resumed.automationGrant,
        },
      );
      const completed = await surface.observe(resumed.sessionId);
      const savings = completed.elements.find(
        (element) =>
          element.context.rowLabel === "Savings" &&
          element.context.columnLabel === "Current balance",
      );
      io.stdout(
        `${JSON.stringify({
          status: savings ? "succeeded" : "failed",
          sessionId: resumed.sessionId,
          originalSessionId: intervention.sessionId,
          sameSession: resumed.sessionId === intervention.sessionId,
          savingsBalance: savings?.text,
          auditEvents: intervention.audit().length,
        })}\n`,
      );
      return savings ? 0 : 1;
    }
    io.stdout(
      `${JSON.stringify({ target: target.entryUrl(), health: `${target.origin}/health`, operator: operator.origin })}\n`,
    );
    if (!flag(args, "once")) await waitForShutdown();
    return 0;
  } finally {
    await closeBrowserCommandResources(operator, surface, target);
  }
}

function help(io: CliIo): number {
  io.stdout(
    `Handrail - discover once, replay deterministically\n\nUsage:\n  npm run catalog -- --json\n  npm run demo:offline -- --replays 10 --output work/demo\n  npm run demo:live -- --replays 10 --output work/demo-live\n  npm run discover -- --planner live --goal "Look up the synthetic member savings balance" --target http://127.0.0.1:4312/legacy --output work/discovery-live\n  npm run replay -- --artifact evidence/artifacts/member.balance.lookup.v1.json\n  npm run replay -- --artifact evidence/artifacts/member.balance.lookup.v1.json --scenario session-expired --handoff\n  npm run serve -- --scenario session-expired --port 4312 --operator-port 4313\n\nCore options:\n  --artifact PATH           Capability artifact to replay\n  --artifact-approval PATH  Enable strict replay with a digest-bound approval record\n  --goal TEXT               Natural-language discovery goal (1-500 characters)\n  --target URL              HTTP(S) /legacy target; omitted starts the synthetic target\n  --planner scripted|live   Live defaults to native Ollama\n  --run-id ID               Stable caller-supplied run ID\n  --output DIRECTORY        Exact evidence directory\n  --source-revision COMMIT  Bind evidence to a 40-character Git revision\n  --member-id VALUE         Synthetic invocation input\n  --replays COUNT           Successful deterministic replays in demo (1-50)\n  --handoff                 Open a same-session operator console during replay\n  --headed                  Show Chromium\n  --include-screenshot      Send screenshots to a configured vision model\n\nLive environment:\n  HANDRAIL_PLANNER_PROVIDER=ollama|openai-compatible\n  HANDRAIL_OLLAMA_BASE_URL or OLLAMA_BASE_URL (default http://127.0.0.1:11434)\n  HANDRAIL_MODEL or OLLAMA_MODEL (default qwen3:4b)\n  HANDRAIL_ALLOW_REMOTE_MODEL_EGRESS=false (required for non-loopback compatible endpoints)\n  LLM_BASE_URL, LLM_API_KEY, LLM_MODEL (openai-compatible only)\n`,
  );
  return 0;
}

export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const args = parseArguments(argv);
  if (!args.command || flag(args, "help")) return help(io);
  if (args.positionals.length > 0) {
    throw new Error(`Unexpected positional argument ${args.positionals[0]}.`);
  }
  switch (args.command) {
    case "catalog":
      return catalog(io, flag(args, "json"));
    case "demo":
      return runDemo(args, io, plannerMode(args));
    case "discover":
      return runDiscovery(args, io, plannerMode(args));
    case "replay":
      return runReplay(args, io);
    case "serve":
      return serve(args, io);
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Handrail command failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
