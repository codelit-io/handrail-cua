import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { attachHandoffEvidence } from "../scripts/attach-handoff-evidence.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "handrail-attach-test-"));
  temporaryDirectories.push(root);
  return root;
}

async function makeBundle(root: string): Promise<string> {
  const bundle = path.join(root, "bundle");
  await mkdir(path.join(bundle, "runs"), { recursive: true });
  await writeFile(
    path.join(bundle, "manifest.json"),
    `${JSON.stringify({ schemaVersion: "1.2.0", runs: [] }, null, 2)}\n`,
    "utf8",
  );
  return bundle;
}

async function makeRun(root: string, runId: string): Promise<string> {
  const run = path.join(root, runId);
  const screenshots = path.join(run, "screenshots");
  await mkdir(screenshots, { recursive: true });
  const definitions = [
    ["checkpoint.png", Buffer.from("checkpoint-image")],
    ["expired.png", Buffer.from("expired-image")],
    ["restored.png", Buffer.from("restored-image")],
  ] as const;
  const refs = await Promise.all(
    definitions.map(async ([name, bytes], index) => {
      await writeFile(path.join(screenshots, name), bytes);
      return {
        id: `screenshot-${runId}-${index + 1}`,
        kind: "screenshot",
        relativePath: `screenshots/${name}`,
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
        mimeType: "image/png",
        createdAt: `2026-08-28T12:00:0${index}.000Z`,
      } as const;
    }),
  );
  const summary = {
    kind: "replay",
    scenario: "handoff",
    result: {
      status: "succeeded",
      outputs: { savingsBalance: 1284.37 },
      checkpointEvidence: [refs[0]],
      meta: {
        runId,
        artifactId: "member.balance.lookup",
        artifactDigest: "a".repeat(64),
        sessionId: `session-${runId}`,
        startedAt: "2026-08-28T12:00:00.000Z",
        finishedAt: "2026-08-28T12:00:01.000Z",
        durationMs: 1_000,
        modelCalls: 0,
        ownerEpoch: 3,
      },
    },
    handoff: {
      interventionId: `intervention-${runId}`,
      reason: "SESSION_EXPIRED",
      originalSessionId: `session-${runId}`,
      resumedSessionId: `session-${runId}`,
      sameSession: true,
      automationEpochBefore: 1,
      operatorEpoch: 2,
      automationEpochAfter: 3,
      checkpointPassed: true,
      operatorAuditEvents: 9,
      evidence: refs.slice(1),
    },
  };
  await writeFile(path.join(run, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(path.join(run, "events.redacted.jsonl"), "{}\n", "utf8");
  return run;
}

describe("handoff evidence attachment", () => {
  it("publishes a complete run and manifest entry", async () => {
    const root = await fixtureRoot();
    const bundle = await makeBundle(root);
    const run = await makeRun(root, "handoff-positive");

    const report = await attachHandoffEvidence({ bundle, run });

    assert.deepEqual(report, { status: "attached", runId: "handoff-positive", bundle });
    const manifest = JSON.parse(await readFile(path.join(bundle, "manifest.json"), "utf8")) as {
      runs: Array<{ id: string; screenshots: unknown[] }>;
    };
    assert.equal(manifest.runs[0]?.id, "handoff-positive");
    assert.equal(manifest.runs[0]?.screenshots.length, 3);
    await access(path.join(bundle, "runs", "handoff-positive", "summary.json"));
    await assert.rejects(access(path.join(bundle, ".attach.lock")));
  });

  it("rejects duplicate evidence paths and hash mismatches", async () => {
    const root = await fixtureRoot();
    const duplicateBundle = await makeBundle(path.join(root, "duplicate-case"));
    const duplicateRun = await makeRun(path.join(root, "duplicate-case"), "handoff-duplicate");
    const summaryPath = path.join(duplicateRun, "summary.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
      handoff: { evidence: unknown[] };
    };
    summary.handoff.evidence = [summary.handoff.evidence[0], summary.handoff.evidence[0]];
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await assert.rejects(
      attachHandoffEvidence({ bundle: duplicateBundle, run: duplicateRun }),
      /duplicate screenshot paths/u,
    );

    const corruptBundle = await makeBundle(path.join(root, "corrupt-case"));
    const corruptRun = await makeRun(path.join(root, "corrupt-case"), "handoff-corrupt");
    await writeFile(path.join(corruptRun, "screenshots", "restored.png"), "changed", "utf8");
    await assert.rejects(
      attachHandoffEvidence({ bundle: corruptBundle, run: corruptRun }),
      /does not match its evidence ref/u,
    );
  });

  it("rejects symlinked evidence inputs", async () => {
    const root = await fixtureRoot();
    const bundle = await makeBundle(root);
    const run = await makeRun(root, "handoff-symlink");
    const screenshot = path.join(run, "screenshots", "restored.png");
    const outside = path.join(root, "outside.png");
    await writeFile(outside, "outside", "utf8");
    await rm(screenshot);
    await symlink(outside, screenshot);

    await assert.rejects(
      attachHandoffEvidence({ bundle, run }),
      /regular file and cannot be a symlink/u,
    );
  });

  it("rejects a symlinked runs directory before writing outside the bundle", async () => {
    const root = await fixtureRoot();
    const bundle = path.join(root, "bundle");
    const outsideRuns = path.join(root, "outside-runs");
    await mkdir(bundle);
    await mkdir(outsideRuns);
    const manifestPath = path.join(bundle, "manifest.json");
    const manifestBefore = `${JSON.stringify({ schemaVersion: "1.2.0", runs: [] }, null, 2)}\n`;
    await writeFile(manifestPath, manifestBefore, "utf8");
    await symlink(outsideRuns, path.join(bundle, "runs"));
    const run = await makeRun(root, "handoff-symlinked-runs");

    await assert.rejects(
      attachHandoffEvidence({ bundle, run }),
      /runs directory must be a real directory and cannot be a symlink/u,
    );

    assert.deepEqual(await readdir(outsideRuns), []);
    assert.equal(await readFile(manifestPath, "utf8"), manifestBefore);
    await assert.rejects(access(path.join(bundle, ".attach.lock")));
  });

  it("serializes cooperating writers with an exclusive bundle lock", async () => {
    const root = await fixtureRoot();
    const bundle = await makeBundle(root);
    const firstRun = await makeRun(root, "handoff-first");
    const secondRun = await makeRun(root, "handoff-second");
    let release!: () => void;
    let published!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publication = new Promise<void>((resolve) => {
      published = resolve;
    });
    const first = attachHandoffEvidence(
      { bundle, run: firstRun },
      {
        afterRunPublished: async () => {
          published();
          await gate;
        },
      },
    );
    await publication;

    await assert.rejects(
      attachHandoffEvidence({ bundle, run: secondRun }),
      /locked by another handoff attachment/u,
    );
    release();
    await first;
  });

  it("rolls back a handled failure between run and manifest publication", async () => {
    const root = await fixtureRoot();
    const bundle = await makeBundle(root);
    const run = await makeRun(root, "handoff-rollback");
    const before = await readFile(path.join(bundle, "manifest.json"), "utf8");

    await assert.rejects(
      attachHandoffEvidence(
        { bundle, run },
        {
          afterRunPublished: async () => {
            throw new Error("injected handled failure");
          },
        },
      ),
      /injected handled failure/u,
    );

    assert.equal(await readFile(path.join(bundle, "manifest.json"), "utf8"), before);
    await assert.rejects(access(path.join(bundle, "runs", "handoff-rollback")));
    await assert.rejects(access(path.join(bundle, ".attach.lock")));
  });

  it("rechecks runs identity before committing the manifest", async () => {
    const root = await fixtureRoot();
    const bundle = await makeBundle(root);
    const run = await makeRun(root, "handoff-runs-swap");
    const runs = path.join(bundle, "runs");
    const parkedRuns = path.join(root, "parked-runs");
    const outsideRuns = path.join(root, "outside-runs");
    await mkdir(outsideRuns);
    const manifestBefore = await readFile(path.join(bundle, "manifest.json"), "utf8");

    await assert.rejects(
      attachHandoffEvidence(
        { bundle, run },
        {
          afterRunPublished: async () => {
            await rename(runs, parkedRuns);
            await symlink(outsideRuns, runs);
          },
        },
      ),
      /could not roll back its published run/u,
    );

    assert.deepEqual(await readdir(outsideRuns), []);
    assert.equal(await readFile(path.join(bundle, "manifest.json"), "utf8"), manifestBefore);
    await access(path.join(parkedRuns, "handoff-runs-swap", "summary.json"));
    await assert.rejects(access(path.join(bundle, ".attach.lock")));
  });
});
