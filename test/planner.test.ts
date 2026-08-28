import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAiCompatiblePlanner } from "../src/model/planner.js";
import type { SurfaceObservation } from "../src/surface/types.js";

function observation(): SurfaceObservation {
  return {
    id: "observation-current",
    sessionId: "surface-planner",
    route: "/legacy",
    title: "Synthetic member search",
    capturedAt: "2026-08-28T02:00:00.000Z",
    screenshotPng: Buffer.from("synthetic-image"),
    viewport: { width: 1280, height: 800 },
    visibleText: "Member number Find Member",
    elements: [
      {
        ref: "member-input",
        framePath: ["name:member-workspace"],
        tagName: "input",
        role: "textbox",
        interactive: true,
        enabled: true,
        bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.04 },
        context: { precedingLabel: "Member number" },
      },
    ],
    fingerprint: "a".repeat(64),
  };
}

describe("OpenAI-compatible discovery planner", () => {
  it("sends a bounded semantic observation without a screenshot to text-only local models", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const planner = new OpenAiCompatiblePlanner({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "local-only",
      model: "qwen3:4b",
      providerName: "ollama-local",
      includeScreenshot: false,
      fetchImplementation: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    decisionId: "decision-fill",
                    observationId: "observation-current",
                    rationale: "Fill the contextual member input.",
                    kind: "set_value",
                    elementRef: "member-input",
                    value: { kind: "input", name: "memberId" },
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 8 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const response = await planner.decide({
      goal: "Look up a synthetic member.",
      inputs: { memberId: "84721" },
      outputs: {},
      observation: observation(),
      allowedActions: ["set_value", "request_help"],
    });

    assert.equal(response.decision.kind, "set_value");
    assert.equal(response.provider, "ollama-local");
    assert.equal(planner.callCount, 1);
    assert.ok(requestBody);
    assert.equal(JSON.stringify(requestBody).includes("image_url"), false);
  });

  it("rejects a stale model decision before it reaches the surface", async () => {
    const planner = new OpenAiCompatiblePlanner({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "local-only",
      model: "fixture",
      includeScreenshot: false,
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    decisionId: "decision-stale",
                    observationId: "observation-old",
                    rationale: "This decision is stale.",
                    kind: "request_help",
                    reason: "stuck",
                    summary: "Stale fixture.",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    await assert.rejects(
      planner.decide({
        goal: "Test stale rejection.",
        inputs: {},
        outputs: {},
        observation: observation(),
        allowedActions: ["request_help"],
      }),
      /stale or invented observation ID/,
    );
  });
});
