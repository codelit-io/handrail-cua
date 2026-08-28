import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type LegacyTargetHandle, startLegacyTarget } from "../src/target/server.js";

describe("synthetic legacy target", () => {
  let target: LegacyTargetHandle;

  before(async () => {
    target = await startLegacyTarget();
  });

  after(async () => {
    await target.close();
  });

  it("serves a healthy, explicitly synthetic shell", async () => {
    const health = await fetch(`${target.origin}/health`).then((response) => response.json());
    assert.deepEqual(health, { status: "ok", target: "handrail-synthetic-legacy" });

    const response = await fetch(target.entryUrl());
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /SYNTHETIC DATA/);
    assert.match(body, /Member servicing workspace/);
    assert.match(body, /iframe/);
  });

  it("propagates deterministic scenarios into the live iframe", async () => {
    const entry = new URL(target.entryUrl("session-expired", { tenant: "ridge-variant" }));
    assert.equal(entry.searchParams.get("scenario"), "session-expired");
    assert.equal(entry.searchParams.get("tenant"), "ridge-variant");

    const workspace = await fetch(`${target.origin}/legacy/workspace?scenario=notice`);
    const body = await workspace.text();
    assert.equal(workspace.status, 200);
    assert.match(body, /Member number/);
    assert.match(body, /legacy\.js/);
    assert.doesNotMatch(body, /data-testid/);
  });

  it("fails unknown routes without leaking local paths", async () => {
    const response = await fetch(`${target.origin}/private-source`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found");
  });
});
