import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
        operatorAuditEvents: z.number().int().min(9),
        evidence: z.array(EvidenceRefSchema).min(2).max(20),
      })
      .strict(),
  })
  .strict();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegularFile(absolutePath: string, label: string): Promise<Buffer> {
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file and cannot be a symlink.`);
  }
  return readFile(absolutePath);
}

interface RealDirectoryIdentity {
  readonly absolutePath: string;
  readonly realPath: string;
  readonly device: number;
  readonly inode: number;
}

async function captureRealDirectory(
  absolutePath: string,
  label: string,
): Promise<RealDirectoryIdentity> {
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory and cannot be a symlink.`);
  }
  const canonical = await realpath(absolutePath);
  const canonicalMetadata = await lstat(canonical);
  if (
    canonicalMetadata.isSymbolicLink() ||
    !canonicalMetadata.isDirectory() ||
    canonicalMetadata.dev !== metadata.dev ||
    canonicalMetadata.ino !== metadata.ino
  ) {
    throw new Error(`${label} changed while its identity was being verified.`);
  }
  return {
    absolutePath,
    realPath: canonical,
    device: metadata.dev,
    inode: metadata.ino,
  };
}

async function assertRealDirectoryIdentity(
  identity: RealDirectoryIdentity,
  label: string,
): Promise<void> {
  const metadata = await lstat(identity.absolutePath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== identity.device ||
    metadata.ino !== identity.inode ||
    (await realpath(identity.absolutePath)) !== identity.realPath
  ) {
    throw new Error(`${label} changed during handoff attachment.`);
  }
}

async function requireRealDirectory(absolutePath: string, label: string): Promise<void> {
  await captureRealDirectory(absolutePath, label);
}

function requireCanonicalChild(
  parent: RealDirectoryIdentity,
  child: RealDirectoryIdentity,
  label: string,
): void {
  if (!child.realPath.startsWith(`${parent.realPath}${path.sep}`)) {
    throw new Error(`${label} must resolve inside the destination evidence bundle.`);
  }
}

async function assertDestinationIdentity(
  bundle: RealDirectoryIdentity,
  runs: RealDirectoryIdentity,
): Promise<void> {
  await assertRealDirectoryIdentity(bundle, "Destination evidence bundle");
  await assertRealDirectoryIdentity(runs, "Destination evidence runs directory");
  requireCanonicalChild(bundle, runs, "Destination evidence runs directory");
}

function inside(root: string, relativePath: string): string {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, relativePath);
  if (absolute === absoluteRoot || !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`Handoff evidence path ${relativePath} escapes its run directory.`);
  }
  return absolute;
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

export interface AttachHandoffEvidenceOptions {
  readonly bundle: string;
  readonly run: string;
}

export interface AttachHandoffEvidenceHooks {
  /** Test-only handled-failure injection after publishing the run but before the manifest. */
  readonly afterRunPublished?: () => Promise<void>;
}

export interface AttachHandoffEvidenceReport {
  readonly status: "attached";
  readonly runId: string;
  readonly bundle: string;
}

export async function attachHandoffEvidence(
  options: AttachHandoffEvidenceOptions,
  hooks: AttachHandoffEvidenceHooks = {},
): Promise<AttachHandoffEvidenceReport> {
  const args = { bundle: path.resolve(options.bundle), run: path.resolve(options.run) };
  const bundleDirectory = await captureRealDirectory(args.bundle, "Destination evidence bundle");
  const runsDirectory = await captureRealDirectory(
    path.join(bundleDirectory.realPath, "runs"),
    "Destination evidence runs directory",
  );
  requireCanonicalChild(bundleDirectory, runsDirectory, "Destination evidence runs directory");
  await requireRealDirectory(args.run, "Handoff run");
  await assertDestinationIdentity(bundleDirectory, runsDirectory);
  const lockPath = path.join(bundleDirectory.realPath, ".attach.lock");
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "EEXIST"
    ) {
      throw new Error("The evidence bundle is locked by another handoff attachment.");
    }
    throw error;
  }

  const manifestPath = path.join(bundleDirectory.realPath, "manifest.json");
  const transactionId = `${process.pid}-${randomUUID()}`;
  let staging: string | undefined;
  let manifestStaging: string | undefined;
  let destination: string | undefined;
  let destinationPublished = false;
  let manifestPublished = false;
  try {
    await lock.writeFile(`${process.pid}\n`, "utf8");
    const manifestBytes = await readRegularFile(manifestPath, "Evidence manifest");
    const initialManifestSha256 = sha256(manifestBytes);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      schemaVersion?: unknown;
      runs?: unknown;
      [key: string]: unknown;
    };
    if (manifest.schemaVersion !== "1.2.0" || !Array.isArray(manifest.runs)) {
      throw new Error("The destination must be a Handrail evidence manifest v1.2 bundle.");
    }

    const summaryBytes = await readRegularFile(
      path.join(args.run, "summary.json"),
      "Handoff summary",
    );
    const eventsBytes = await readRegularFile(
      path.join(args.run, "events.redacted.jsonl"),
      "Handoff event log",
    );
    const summary = HandoffSummarySchema.parse(
      JSON.parse(summaryBytes.toString("utf8")) as unknown,
    );
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
    if (new Set(evidence.map((ref) => ref.relativePath)).size !== evidence.length) {
      throw new Error("Handoff run evidence contains duplicate screenshot paths.");
    }
    const screenshots = await Promise.all(
      evidence.map(async (ref) => {
        if (ref.kind !== "screenshot" || ref.mimeType !== "image/png") {
          throw new Error("Handoff run evidence must reference PNG screenshots only.");
        }
        const bytes = await readRegularFile(
          inside(args.run, ref.relativePath),
          `Handoff screenshot ${ref.relativePath}`,
        );
        if (bytes.byteLength !== ref.byteLength || sha256(bytes) !== ref.sha256) {
          throw new Error(
            `Handoff screenshot ${ref.relativePath} does not match its evidence ref.`,
          );
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
    destination = path.join(runsDirectory.realPath, runId);
    staging = path.join(runsDirectory.realPath, `.attach-${runId}-${transactionId}`);
    manifestStaging = path.join(bundleDirectory.realPath, `.manifest-${transactionId}.json`);
    await assertDestinationIdentity(bundleDirectory, runsDirectory);
    await copyTreeExclusive(args.run, staging);
    await writeFile(manifestStaging, `${JSON.stringify(nextManifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await assertDestinationIdentity(bundleDirectory, runsDirectory);
    await rename(staging, destination);
    destinationPublished = true;
    await hooks.afterRunPublished?.();
    await assertDestinationIdentity(bundleDirectory, runsDirectory);
    const currentManifestBytes = await readRegularFile(manifestPath, "Evidence manifest");
    if (sha256(currentManifestBytes) !== initialManifestSha256) {
      throw new Error("Evidence manifest changed during handoff attachment.");
    }
    await rename(manifestStaging, manifestPath);
    manifestPublished = true;
    return { status: "attached", runId, bundle: args.bundle };
  } catch (error) {
    let rollbackError: unknown;
    let bundlePathIsSafe = false;
    let runsPathIsSafe = false;
    try {
      await assertRealDirectoryIdentity(bundleDirectory, "Destination evidence bundle");
      bundlePathIsSafe = true;
    } catch (failure) {
      if (manifestStaging) rollbackError = failure;
    }
    try {
      await assertRealDirectoryIdentity(runsDirectory, "Destination evidence runs directory");
      requireCanonicalChild(bundleDirectory, runsDirectory, "Destination evidence runs directory");
      runsPathIsSafe = true;
    } catch (failure) {
      if (staging || destinationPublished) rollbackError ??= failure;
    }
    if (runsPathIsSafe && destinationPublished && !manifestPublished && destination && staging) {
      try {
        await rename(destination, staging);
      } catch (failure) {
        rollbackError = failure;
      }
    }
    if (runsPathIsSafe && staging) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    if (bundlePathIsSafe && manifestStaging) {
      await rm(manifestStaging, { force: true }).catch(() => undefined);
    }
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Handoff attachment failed and could not roll back its published run.",
      );
    }
    throw error;
  } finally {
    await lock.close().catch(() => undefined);
    try {
      await assertRealDirectoryIdentity(bundleDirectory, "Destination evidence bundle");
      await rm(lockPath, { force: true });
    } catch {
      // Never follow a replaced bundle path merely to clean up the cooperative lock.
    }
  }
}

async function main(): Promise<void> {
  const report = await attachHandoffEvidence(argumentsFrom(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    process.stderr.write(
      `Handoff attachment failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
