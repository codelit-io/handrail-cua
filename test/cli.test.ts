import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  assertStableModelEvidence,
  CliEvidenceWriter,
  type CliIo,
  discoverySummary,
  isPlaywrightAlreadyClosedError,
  replaySummary,
  resolvedModelEvidence,
  resolveScreenshotModelInput,
  resolveTargetSource,
  runCli,
  waitForExternalArtifactApproval,
} from "../src/cli.js";
import { type CapabilityArtifact, type RunResult, RunResultSchema } from "../src/domain/schema.js";
import type { DiscoveryResult } from "../src/runtime/discovery.js";
import { INTERNAL_REDACTION, PII_REDACTION, SECRET_REDACTION } from "../src/runtime/redaction.js";
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
    assert.match(help, /--artifact-approval PATH/);
    assert.match(help, /--approval-timeout-ms MS/);
    assert.match(help, /npm run approve/u);
    assert.match(help, /Required digest-bound approval/u);
    assert.match(help, /--source-revision COMMIT/);
  });

  it("derives evidence provenance from effective model and target configuration", () => {
    assert.equal(resolveScreenshotModelInput("live", false, "true"), true);
    assert.equal(resolveScreenshotModelInput("live", false, "false"), false);
    assert.equal(resolveScreenshotModelInput("live", true, "false"), true);
    assert.equal(resolveScreenshotModelInput("scripted", true, "true"), false);
    assert.equal(resolveTargetSource(undefined), "bundled-fixture");
    assert.equal(resolveTargetSource("http://127.0.0.1:4312/legacy"), "external");
  });

  it("requires an exact native Ollama model digest for live evidence", async () => {
    let includeDigest = true;
    const modelDigest = "a".repeat(64);
    const server = createServer((_request, response) => {
      const body = Buffer.from(
        JSON.stringify({
          models: [
            {
              name: "qwen3:4b",
              model: "qwen3:4b",
              ...(includeDigest ? { digest: modelDigest } : {}),
            },
          ],
        }),
        "utf8",
      );
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(body.byteLength),
      });
      response.end(body);
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Ollama fixture did not expose a TCP address."));
          return;
        }
        resolve(address.port);
      });
    });
    const provenance = {
      ...replayArtifact().provenance,
      provider: "ollama-local",
      modelId: "qwen3:4b",
      liveModel: true,
    };
    const env = { HANDRAIL_OLLAMA_BASE_URL: `http://127.0.0.1:${port}` };
    try {
      assert.equal(
        (await resolvedModelEvidence(provenance, env, "native-ollama", true)).digest,
        modelDigest,
      );
      includeDigest = false;
      await assert.rejects(
        resolvedModelEvidence(provenance, env, "native-ollama", true),
        /requires the selected model's 64-character SHA-256 digest/u,
      );
      await assert.rejects(
        resolvedModelEvidence(provenance, env, "openai-compatible", true),
        /requires the selected model's 64-character SHA-256 digest/u,
      );
      assert.equal(
        (await resolvedModelEvidence(provenance, env, "native-ollama")).digest,
        undefined,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("fails closed if the model identity or digest changes during discovery", () => {
    const before = {
      provider: "ollama-local",
      modelId: "qwen3:4b",
      liveModel: true,
      digest: "a".repeat(64),
    };
    assert.deepEqual(assertStableModelEvidence(before, { ...before }), before);
    assert.throws(
      () => assertStableModelEvidence(before, { ...before, digest: "b".repeat(64) }),
      /changed while discovery was running/u,
    );
  });

  it("continues only after an independently written exact artifact approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-cli-external-approval-"));
    temporaryDirectories.push(root);
    const approvalPath = path.join(root, "artifact-approval.json");
    const artifact = replayArtifact();
    const approval = {
      artifactId: artifact.id,
      revision: artifact.revision,
      digest: artifact.digest,
      approvedBy: "reviewer-02",
      approvedAt: "2026-08-27T18:30:00.000Z",
    } as const;

    const waiting = waitForExternalArtifactApproval(
      artifact,
      approvalPath,
      1_000,
      () => new Date("2026-08-27T18:31:00.000Z"),
    );
    await writeFile(approvalPath, `${JSON.stringify(approval, null, 2)}\n`, "utf8");

    assert.deepEqual(await waiting, approval);
  });

  it("requires a new external approval path before a live demo starts a browser", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-cli-live-approval-boundary-"));
    temporaryDirectories.push(root);
    const output = path.join(root, "bundle");
    const capture = captureIo();
    const io: CliIo = { ...capture.io, cwd: root };

    await assert.rejects(
      runCli(["demo", "--planner", "live", "--output", output], io),
      /requires --artifact-approval PATH/u,
    );
    await assert.rejects(access(output));

    const preexisting = path.join(root, "approval", "artifact-approval.json");
    await mkdir(path.dirname(preexisting), { recursive: true });
    await writeFile(preexisting, "{}\n", "utf8");
    await assert.rejects(
      runCli(
        ["demo", "--planner", "live", "--artifact-approval", preexisting, "--output", output],
        io,
      ),
      /must be issued after this discovery run/u,
    );
    await assert.rejects(access(output));

    await assert.rejects(
      runCli(
        [
          "demo",
          "--planner",
          "live",
          "--artifact-approval",
          path.join(output, "approval.json"),
          "--output",
          output,
        ],
        io,
      ),
      /outside the evidence bundle directory/u,
    );
    await assert.rejects(access(output));
  });

  it("rejects a malformed artifact approval before starting browser replay", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-cli-approval-"));
    temporaryDirectories.push(root);
    const artifactPath = path.join(root, "artifact.json");
    const approvalPath = path.join(root, "approval.json");
    await writeFile(artifactPath, `${JSON.stringify(replayArtifact(), null, 2)}\n`, "utf8");
    await writeFile(approvalPath, `${JSON.stringify({ approvedBy: "reviewer-only" })}\n`, "utf8");
    const capture = captureIo();
    const io: CliIo = { ...capture.io, cwd: root };

    await assert.rejects(
      runCli(
        [
          "replay",
          "--artifact",
          artifactPath,
          "--artifact-approval",
          approvalPath,
          "--output",
          path.join(root, "should-not-exist"),
        ],
        io,
      ),
      /artifactId|revision|digest/u,
    );
    await assert.rejects(access(path.join(root, "should-not-exist")));
    assert.deepEqual(capture.stdout, []);
  });

  it("requires artifact approval before creating replay output or a browser session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-cli-missing-approval-"));
    temporaryDirectories.push(root);
    const artifactPath = path.join(root, "artifact.json");
    const output = path.join(root, "should-not-exist");
    await writeFile(artifactPath, `${JSON.stringify(replayArtifact(), null, 2)}\n`, "utf8");
    const capture = captureIo();
    const io: CliIo = { ...capture.io, cwd: root };

    await assert.rejects(
      runCli(["replay", "--artifact", artifactPath, "--output", output], io),
      /Replay requires --artifact-approval/u,
    );
    await assert.rejects(access(output));
    assert.deepEqual(capture.stdout, []);
  });

  it("writes an immutable digest-bound approval only after explicit review confirmation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-cli-approve-"));
    temporaryDirectories.push(root);
    const artifact = replayArtifact();
    const artifactPath = path.join(root, "artifact.json");
    const output = path.join(root, "approval-output");
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    const capture = captureIo();
    const io: CliIo = { ...capture.io, cwd: root };

    await assert.rejects(
      runCli(
        ["approve", "--artifact", artifactPath, "--reviewer", "reviewer-01", "--output", output],
        io,
      ),
      /requires --confirm-reviewed/u,
    );
    await assert.rejects(access(output));

    assert.equal(
      await runCli(
        [
          "approve",
          "--artifact",
          artifactPath,
          "--reviewer",
          "reviewer-01",
          "--confirm-reviewed",
          "--output",
          output,
        ],
        io,
      ),
      0,
    );
    const approval = JSON.parse(
      await readFile(path.join(output, "artifact-approval.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(approval, {
      artifactId: artifact.id,
      revision: artifact.revision,
      digest: artifact.digest,
      approvedBy: "reviewer-01",
      approvedAt: "2026-08-27T12:00:00.000Z",
    });
    await assert.rejects(
      runCli(
        [
          "approve",
          "--artifact",
          artifactPath,
          "--reviewer",
          "reviewer-01",
          "--confirm-reviewed",
          "--output",
          output,
        ],
        io,
      ),
      /already exists/u,
    );
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
          internalBalance: {
            description: "Opaque internal value",
            classification: "internal",
            validator: { kind: "number" },
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
        internalBalance: 1_284.37,
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
      internalBalance: INTERNAL_REDACTION,
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
