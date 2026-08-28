import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { z } from "zod";
import {
  EvidenceRefSchema,
  IdentifierSchema,
  InterventionReasonSchema,
  RunResultSchema,
} from "../src/domain/schema.js";

const HandoffSummarySchema = z
  .object({
    kind: z.literal("replay"),
    scenario: z.literal("handoff"),
    result: RunResultSchema,
    handoff: z
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
        operatorAuditEvents: z.number().int().min(4),
        evidence: z.array(EvidenceRefSchema).min(2).max(20),
      })
      .strict(),
  })
  .strict();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function argumentsFrom(argv: readonly string[]): { bundle: string; run: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--bundle" && token !== "--run") {
      throw new Error(`Unknown option ${token ?? "<empty>"}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a directory.`);
    values.set(token.slice(2), value);
    index += 1;
  }
  const bundle = values.get("bundle");
  const run = values.get("run");
  if (!bundle || !run) throw new Error("Usage: --bundle DIRECTORY --run DIRECTORY");
  return { bundle: path.resolve(bundle), run: path.resolve(run) };
}

async function copyTreeExclusive(source: string, destination: string): Promise<void> {
  await mkdir(destination);
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink())
      throw new Error(`Handoff evidence cannot contain ${entry.name}.`);
    if (metadata.isDirectory()) {
      await copyTreeExclusive(sourcePath, destinationPath);
    } else if (metadata.isFile()) {
      await copyFile(sourcePath, destinationPath, fileConstants.COPYFILE_EXCL);
    } else {
      throw new Error(`Unsupported handoff evidence entry ${entry.name}.`);
    }
  }
}

function resultEvidence(result: z.infer<typeof RunResultSchema>) {
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

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2));
  const manifestPath = path.join(args.bundle, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    schemaVersion?: unknown;
    runs?: unknown;
    [key: string]: unknown;
  };
  if (manifest.schemaVersion !== "1.2.0" || !Array.isArray(manifest.runs)) {
    throw new Error("The destination must be a Handrail evidence manifest v1.2 bundle.");
  }

  const summaryBytes = await readFile(path.join(args.run, "summary.json"));
  const eventsBytes = await readFile(path.join(args.run, "events.redacted.jsonl"));
  const summary = HandoffSummarySchema.parse(JSON.parse(summaryBytes.toString("utf8")) as unknown);
  if (summary.result.status !== "succeeded") {
    throw new Error("Only a successfully resumed handoff run can be attached.");
  }
  const runId = summary.result.meta.runId;
  if (
    summary.result.meta.sessionId !== summary.handoff.originalSessionId ||
    summary.handoff.originalSessionId !== summary.handoff.resumedSessionId
  ) {
    throw new Error("Handoff session IDs do not prove same-session continuity.");
  }
  if (manifest.runs.some((run) => (run as { id?: unknown }).id === runId)) {
    throw new Error(`Evidence manifest already contains run ${runId}.`);
  }

  const evidence = [...resultEvidence(summary.result), ...summary.handoff.evidence];
  const screenshots = await Promise.all(
    evidence.map(async (ref) => {
      if (ref.kind !== "screenshot" || ref.mimeType !== "image/png") {
        throw new Error("Handoff run evidence must reference PNG screenshots only.");
      }
      const bytes = await readFile(path.join(args.run, ref.relativePath));
      if (bytes.byteLength !== ref.byteLength || sha256(bytes) !== ref.sha256) {
        throw new Error(`Handoff screenshot ${ref.relativePath} does not match its evidence ref.`);
      }
      return {
        relativePath: path.posix.join("runs", runId, ref.relativePath),
        sha256: ref.sha256,
        byteLength: ref.byteLength,
        mimeType: "image/png" as const,
      };
    }),
  );

  const runEntry = {
    id: runId,
    kind: "replay",
    scenario: "handoff",
    directory: `runs/${runId}`,
    summary: `runs/${runId}/summary.json`,
    summarySha256: sha256(summaryBytes),
    events: `runs/${runId}/events.redacted.jsonl`,
    eventsSha256: sha256(eventsBytes),
    screenshots,
  };
  const nextManifest = { ...manifest, runs: [...manifest.runs, runEntry] };
  const destination = path.join(args.bundle, "runs", runId);
  const staging = path.join(args.bundle, "runs", `.attach-${runId}-${process.pid}`);
  const manifestStaging = path.join(args.bundle, `.manifest-${process.pid}.json`);
  await copyTreeExclusive(args.run, staging);
  await writeFile(manifestStaging, `${JSON.stringify(nextManifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(staging, destination);
  await rename(manifestStaging, manifestPath);
  process.stdout.write(`${JSON.stringify({ status: "attached", runId, bundle: args.bundle })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    process.stderr.write(
      `Handoff attachment failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
