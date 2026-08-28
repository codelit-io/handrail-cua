import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { validateEvidenceBundle } from "../scripts/validate-evidence.js";

interface MutableScreenshotRef {
  relativePath: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
}

interface MutableManifestRun {
  id: string;
  directory: string;
  summary: string;
  summarySha256: string;
  screenshots: MutableScreenshotRef[];
}

interface MutableManifest {
  runs: MutableManifestRun[];
}

interface MutableEvidenceRef extends MutableScreenshotRef {
  kind: string;
}

interface MutableSummary {
  kind: "discovery" | "replay";
  evidence?: MutableEvidenceRef[];
  result?: {
    status: "succeeded" | "business_outcome" | "needs_intervention" | "failed";
    checkpointEvidence?: MutableEvidenceRef[];
    evidence?: MutableEvidenceRef[];
    intervention?: { evidence: MutableEvidenceRef[] };
    error?: { evidence: MutableEvidenceRef[] };
  };
}

const temporaryDirectories: string[] = [];

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("strict screenshot evidence validation", () => {
  it("accepts the complete committed live evidence inventory", async () => {
    const report = await validateEvidenceBundle(path.resolve("evidence"));
    assert.equal(report.runs, 12);
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
    });
    await writeFile(changed.absolute, invalid);

    await assert.rejects(validateEvidenceBundle(root), /valid PNG signature/u);
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
