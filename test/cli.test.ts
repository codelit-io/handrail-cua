import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  CliEvidenceWriter,
  type CliIo,
  discoverySummary,
  isPlaywrightAlreadyClosedError,
  replaySummary,
  runCli,
} from "../src/cli.js";
import { type CapabilityArtifact, type RunResult, RunResultSchema } from "../src/domain/schema.js";
import type { DiscoveryResult } from "../src/runtime/discovery.js";
import { PII_REDACTION, SECRET_REDACTION } from "../src/runtime/redaction.js";
import { replayArtifact } from "./fixtures/replay/scenario.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd: process.cwd(),
      env: {},
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    stdout,
    stderr,
  };
}

describe("public CLI", () => {
  it("emits a machine-readable capability catalog without starting a browser", async () => {
    const capture = captureIo();

    assert.equal(await runCli(["catalog", "--json"], capture.io), 0);
    const catalog = JSON.parse(capture.stdout.join("")) as Array<{
      id: string;
      plannerModes: string[];
    }>;

    assert.equal(catalog[0]?.id, "member.balance.lookup");
    assert.deepEqual(catalog[0]?.plannerModes, ["scripted", "live"]);
    assert.deepEqual(capture.stderr, []);
  });

  it("fails closed on unknown options", async () => {
    const capture = captureIo();

    await assert.rejects(runCli(["catalog", "--unsafe"], capture.io), /Unknown option --unsafe/);
    assert.deepEqual(capture.stdout, []);
  });

  it("documents the live Ollama and stability defaults", async () => {
    const capture = captureIo();

    assert.equal(await runCli(["--help"], capture.io), 0);
    const help = capture.stdout.join("");
    assert.match(help, /OLLAMA_BASE_URL/);
    assert.match(help, /qwen3:4b/);
    assert.match(help, /--replays 10/);
    assert.match(help, /--handoff/);
    assert.match(help, /--goal TEXT/);
    assert.match(help, /--target URL/);
  });

  it("recognizes only Playwright's already-closed shutdown error", () => {
    assert.equal(
      isPlaywrightAlreadyClosedError(
        new Error("browserContext.close: Target page, context or browser has been closed"),
      ),
      true,
    );
    assert.equal(
      isPlaywrightAlreadyClosedError(new Error("browserContext.close: disk failure")),
      false,
    );
    assert.equal(
      isPlaywrightAlreadyClosedError("Target page, context or browser has been closed"),
      false,
    );
  });

  it("persists canonical artifact JSON through the immutable evidence boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-cli-artifact-"));
    temporaryDirectories.push(root);
    const writer = new CliEvidenceWriter({
      rootDirectory: root,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
    });
    const artifact = {
      contract: { inputs: { memberId: { type: "string" } } },
      targets: { "input-memberId": { label: "Synthetic member number" } },
    };

    const ref = await writer.writeJson("artifacts/canonical.json", artifact, "artifact");
    assert.equal(
      await readFile(path.join(root, ref.relativePath), "utf8"),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
    assert.equal(ref.kind, "artifact");
  });

  it("redacts declared outputs and free-form terminal text from CLI JSON summaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-cli-summary-redaction-"));
    temporaryDirectories.push(root);
    const writer = new CliEvidenceWriter({ rootDirectory: root });
    const unusualPii = "quartz-profile-person-9Vz";
    const classifiedOpaque = "orchid-broker-material-4Np";
    const base = replayArtifact();
    const artifact: CapabilityArtifact = {
      ...base,
      contract: {
        ...base.contract,
        outputs: {
          privateProfile: {
            description: "Opaque profile value",
            classification: "pii",
            validator: { kind: "string" },
          },
          brokerMaterial: {
            description: "Opaque broker value",
            classification: "secret",
            validator: { kind: "string" },
          },
          publicStatus: {
            description: "Public completion status",
            classification: "public",
            validator: { kind: "string" },
          },
        },
      },
    };
    const meta: RunResult["meta"] = {
      runId: "run-cli-projection",
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
      sessionId: "session-cli-projection",
      startedAt: "2030-01-01T00:00:00.000Z",
      finishedAt: "2030-01-01T00:00:01.000Z",
      durationMs: 1_000,
      modelCalls: 0,
      ownerEpoch: 1,
    };
    const replayResult: RunResult = {
      status: "succeeded",
      outputs: {
        privateProfile: unusualPii,
        brokerMaterial: classifiedOpaque,
        publicStatus: "complete",
      },
      checkpointEvidence: [],
      meta,
    };
    const discoveryResult: DiscoveryResult = {
      status: "succeeded",
      runId: "run-cli-projection",
      sessionId: "session-cli-projection",
      modelCalls: 1,
      recoveries: 0,
      evidence: [],
      artifact,
      outputs: replayResult.outputs,
    };
    const interventionResult: RunResult = {
      status: "needs_intervention",
      intervention: {
        id: "intervention-cli-projection",
        runId: meta.runId,
        sessionId: meta.sessionId,
        reason: "UNKNOWN_STATE",
        summary: `Help with ${unusualPii}.`,
        observedState: `Surface contains ${classifiedOpaque}.`,
        allowedActions: ["claim", "resume"],
        evidence: [],
        ownerEpoch: 2,
        createdAt: "2030-01-01T00:00:01.000Z",
      },
      meta,
    };
    const failedResult: RunResult = {
      status: "failed",
      error: {
        code: "POSTCONDITION_FAILED",
        message: `Failure for ${unusualPii}.`,
        phase: "replay",
        retryable: false,
        expected: `Expected ${classifiedOpaque}.`,
        observed: `Observed ${unusualPii}.`,
        evidence: [],
      },
      meta,
    };

    await writer.writeJson("replay.json", replaySummary("success", replayResult, artifact));
    await writer.writeJson("discovery.json", discoverySummary(discoveryResult));
    await writer.writeJson(
      "intervention.json",
      replaySummary("exception", interventionResult, artifact),
    );
    await writer.writeJson("failure.json", replaySummary("exception", failedResult, artifact));

    const persisted = await Promise.all(
      ["replay.json", "discovery.json", "intervention.json", "failure.json"].map((file) =>
        readFile(path.join(root, file), "utf8"),
      ),
    );
    const serialized = persisted.join("\n");
    assert.equal(serialized.includes(unusualPii), false);
    assert.equal(serialized.includes(classifiedOpaque), false);
    const replay = JSON.parse(persisted[0] ?? "") as {
      result: { outputs: Record<string, unknown> };
    };
    assert.deepEqual(replay.result.outputs, {
      privateProfile: PII_REDACTION,
      brokerMaterial: SECRET_REDACTION,
      publicStatus: "complete",
    });
    assert.doesNotThrow(() => RunResultSchema.parse(replay.result));
    const intervention = JSON.parse(persisted[2] ?? "") as {
      result: { intervention: Record<string, unknown> };
    };
    assert.equal(
      intervention.result.intervention.summary,
      "Human intervention details omitted from persistent evidence.",
    );
    assert.equal(
      intervention.result.intervention.observedState,
      "Surface details omitted from persistent evidence.",
    );
    assert.doesNotThrow(() => RunResultSchema.parse(intervention.result));
    const failure = JSON.parse(persisted[3] ?? "") as {
      result: { error: Record<string, unknown> };
    };
    assert.equal(failure.result.error.message, "Failure details omitted from persistent evidence.");
    assert.equal(Object.hasOwn(failure.result.error, "expected"), false);
    assert.equal(Object.hasOwn(failure.result.error, "observed"), false);
    assert.doesNotThrow(() => RunResultSchema.parse(failure.result));
  });

  it("rejects a symlink evidence root before canonical artifact persistence", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "handrail-cli-root-link-"));
    temporaryDirectories.push(parent);
    const outside = path.join(parent, "outside");
    const linkedRoot = path.join(parent, "evidence");
    await mkdir(outside);
    await symlink(outside, linkedRoot, "dir");
    const writer = new CliEvidenceWriter({ rootDirectory: linkedRoot });

    await assert.rejects(
      writer.writeJson("artifacts/canonical.json", { safe: true }, "artifact"),
      /rootDirectory itself must not be a symlink/u,
    );
    await assert.rejects(access(path.join(outside, "artifacts", "canonical.json")));
  });

  it("rejects a symlinked artifact directory without writing outside the root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "handrail-cli-artifacts-link-"));
    temporaryDirectories.push(parent);
    const root = path.join(parent, "evidence");
    const outside = path.join(parent, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, path.join(root, "artifacts"), "dir");
    const writer = new CliEvidenceWriter({ rootDirectory: root });

    await assert.rejects(
      writer.writeJson("artifacts/canonical.json", { safe: true }, "artifact"),
      /cannot contain symlinks/u,
    );
    await assert.rejects(access(path.join(outside, "canonical.json")));
  });

  it("rejects nested parent symlinks without creating descendants outside the root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "handrail-cli-nested-link-"));
    temporaryDirectories.push(parent);
    const root = path.join(parent, "evidence");
    const outside = path.join(parent, "outside");
    await mkdir(path.join(root, "artifacts"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(root, "artifacts", "escape"), "dir");
    const writer = new CliEvidenceWriter({ rootDirectory: root });

    await assert.rejects(
      writer.writeJson(
        "artifacts/escape/created-outside/canonical.json",
        { safe: true },
        "artifact",
      ),
      /cannot contain symlinks/u,
    );
    await assert.rejects(access(path.join(outside, "created-outside")));
  });
});
