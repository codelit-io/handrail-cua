import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlannerRequest } from "../src/model/planner.js";
import {
  computePromptTraceHash,
  OllamaPlanner,
  OpenAiCompatiblePlanner,
  PlannerDecisionError,
  ScriptedPlanner,
  ThrowingPlanner,
} from "../src/model/planner.js";
import type { SurfaceObservation } from "../src/surface/types.js";

function observation(): SurfaceObservation {
  return {
    id: "observation-current",
    sessionId: "surface-planner",
    url: "http://127.0.0.1:4312/legacy",
    route: "/legacy",
    title: "Synthetic member search",
    capturedAt: "2026-08-28T02:00:00.000Z",
    screenshotPng: Buffer.from("synthetic-image"),
    viewport: { width: 1280, height: 800 },
    visibleText: "Member number Find Member Savings Current balance $1,284.37",
    elements: [
      {
        ref: "member-input",
        framePath: ["name:member-workspace"],
        tagName: "input",
        role: "textbox",
        interactive: true,
        enabled: true,
        bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.04 },
        context: {
          precedingLabel: "Member number",
          rowText: ["84721", "Violet Orbit Person"],
        },
      },
      {
        ref: "balance-cell",
        framePath: ["name:member-workspace"],
        tagName: "td",
        role: "cell",
        name: "$1,284.37",
        text: "$1,284.37",
        interactive: false,
        enabled: true,
        bounds: { x: 0.5, y: 0.4, width: 0.2, height: 0.04 },
        context: {
          rowLabel: "Savings",
          columnLabel: "Current balance",
          rowText: ["84721", "Violet Orbit Person", "$1,284.37"],
        },
      },
    ],
    fingerprint: "a".repeat(64),
  };
}

function plannerRequest(goal = "Exercise the bounded planner."): PlannerRequest {
  return {
    goal,
    inputs: { memberId: "84721" },
    inputSpecs: {
      memberId: {
        description: "Synthetic member number.",
        classification: "pii",
        required: true,
        validator: { kind: "string", minLength: 5, maxLength: 5 },
      },
    },
    outputs: {},
    outputSpecs: {},
    observation: observation(),
    allowedActions: ["request_help"],
  };
}

function openAiHelpResponse(observationId: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              decisionId: "decision-help",
              observationId,
              rationale: "Request bounded help.",
              kind: "request_help",
              reason: "stuck",
              summary: "Synthetic help boundary.",
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("OpenAI-compatible discovery planner", () => {
  it("sends a bounded semantic observation without a screenshot to text-only local models", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let redirectMode: RequestRedirect | undefined;
    const planner = new OpenAiCompatiblePlanner({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "local-only",
      model: "qwen3:4b",
      providerName: "openai-compatible-local",
      includeScreenshot: false,
      fetchImplementation: async (_input, init) => {
        redirectMode = init?.redirect;
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

    const unsafeObservation = observation();
    unsafeObservation.route = "/members/john@example.com";
    const unsafeElement = unsafeObservation.elements[0];
    assert.ok(unsafeElement);
    unsafeElement.role = "sk-proj-abcdefghijklmnop";
    unsafeElement.inputType = "AKIAABCDEFGHIJKLMNOP";

    const response = await planner.decide({
      goal: "Look up a synthetic member for john@example.com with sk-proj-abcdefghijklmnop.",
      inputs: { memberId: "84721", memberName: "Violet Orbit Person" },
      inputSpecs: {
        memberId: {
          description: "Synthetic member number.",
          classification: "pii",
          required: true,
          validator: { kind: "string", minLength: 5, maxLength: 5 },
        },
        memberName: {
          description: "Synthetic member name.",
          classification: "pii",
          required: true,
          validator: { kind: "string", minLength: 2, maxLength: 100 },
        },
      },
      outputs: {},
      outputSpecs: {},
      observation: unsafeObservation,
      allowedActions: ["set_value", "request_help"],
    });

    assert.equal(response.decision.kind, "set_value");
    assert.equal(response.provider, "openai-compatible-local");
    assert.equal(planner.callCount, 1);
    assert.ok(requestBody);
    assert.equal(JSON.stringify(requestBody).includes("image_url"), false);
    assert.equal(JSON.stringify(requestBody).includes("84721"), false);
    assert.equal(JSON.stringify(requestBody).includes("Violet Orbit Person"), false);
    assert.equal(JSON.stringify(requestBody).includes("$1,284.37"), false);
    assert.equal(JSON.stringify(requestBody).includes("john@example.com"), false);
    assert.equal(JSON.stringify(requestBody).includes("sk-proj-abcdefghijklmnop"), false);
    assert.equal(JSON.stringify(requestBody).includes("AKIAABCDEFGHIJKLMNOP"), false);
    assert.equal(redirectMode, "error");
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
        inputSpecs: {},
        outputs: {},
        outputSpecs: {},
        observation: observation(),
        allowedActions: ["request_help"],
      }),
      /stale or invented observation ID/,
    );
  });

  it("fails closed for a remote model endpoint until data egress is explicitly approved", () => {
    assert.throws(
      () =>
        new OpenAiCompatiblePlanner({
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: "local-only",
          model: "fixture",
          providerName: "ollama-local",
        }),
      /reserved for its native planner transport/u,
    );
    assert.throws(
      () =>
        new OpenAiCompatiblePlanner({
          baseUrl: "https://model.example.test/v1",
          apiKey: "test-only",
          model: "fixture",
        }),
      /requires allowRemoteDataEgress=true/,
    );
    assert.throws(
      () =>
        new OllamaPlanner({
          baseUrl: "https://ollama.example.test",
          model: "fixture",
        }),
      /requires allowRemoteDataEgress=true/u,
    );
    assert.throws(
      () =>
        new OpenAiCompatiblePlanner({
          baseUrl: "http://model.example.test/v1",
          apiKey: "test-only",
          model: "fixture",
          allowRemoteDataEgress: true,
        }),
      /must use HTTPS/u,
    );
    assert.throws(
      () =>
        new OllamaPlanner({
          baseUrl: "http://ollama.example.test",
          model: "fixture",
          allowRemoteDataEgress: true,
        }),
      /must use HTTPS/u,
    );
    assert.equal(
      new OllamaPlanner({
        baseUrl: "https://ollama.example.test",
        model: "fixture",
        allowRemoteDataEgress: true,
      }).provider,
      "ollama-remote-approved",
    );
  });

  it("classifies a successful response with no decision payload as a contract error", async () => {
    const planner = new OpenAiCompatiblePlanner({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "local-only",
      model: "fixture",
      fetchImplementation: async () =>
        new Response(JSON.stringify({ choices: [{ message: {} }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await assert.rejects(
      planner.decide({
        goal: "Test empty response classification.",
        inputs: {},
        inputSpecs: {},
        outputs: {},
        outputSpecs: {},
        observation: observation(),
        allowedActions: ["request_help"],
      }),
      (error: unknown) => error instanceof PlannerDecisionError,
    );
  });

  it("refuses automatic redirects for native Ollama requests", async () => {
    let redirectMode: RequestRedirect | undefined;
    let requestBody = "";
    const planner = new OllamaPlanner({
      model: "fixture",
      fetchImplementation: async (_input, init) => {
        redirectMode = init?.redirect;
        requestBody = String(init?.body);
        if (init?.redirect !== "error") throw new Error("redirect policy missing");
        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                decisionId: "decision-help",
                observationId: "observation-current",
                rationale: "Request bounded help.",
                kind: "request_help",
                reason: "stuck",
                summary: "Synthetic help boundary.",
              }),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    await planner.decide({
      goal: "Test redirect policy for john@example.com with sk-proj-abcdefghijklmnop.",
      inputs: {},
      inputSpecs: {},
      outputs: {},
      outputSpecs: {},
      observation: observation(),
      allowedActions: ["request_help"],
    });
    assert.equal(redirectMode, "error");
    assert.equal(requestBody.includes("john@example.com"), false);
    assert.equal(requestBody.includes("sk-proj-abcdefghijklmnop"), false);
    assert.equal(planner.promptHash, computePromptTraceHash("native-ollama", [requestBody]));
  });
});

describe("planner request provenance", () => {
  async function captureOpenAiRequest(
    request: PlannerRequest,
    options: { includeScreenshot?: boolean; model?: string } = {},
  ): Promise<{ body: string; hash: string }> {
    let body = "";
    const planner = new OpenAiCompatiblePlanner({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "local-only",
      model: options.model ?? "fixture",
      includeScreenshot: options.includeScreenshot ?? true,
      fetchImplementation: async (_input, init) => {
        body = String(init?.body);
        return openAiHelpResponse(request.observation.id);
      },
    });
    await planner.decide(request);
    return { body, hash: planner.promptHash };
  }

  it("hashes the exact OpenAI request bytes, including prompt, schema, options, and screenshot", async () => {
    const exact = await captureOpenAiRequest(plannerRequest());
    assert.equal(exact.hash, computePromptTraceHash("openai-compatible", [exact.body]));

    type CapturedBody = {
      model: string;
      max_tokens: number;
      messages: Array<{
        role: string;
        content: string | Array<{ type: string; image_url?: { url?: string }; text?: string }>;
      }>;
      response_format: {
        json_schema: { schema: Record<string, unknown> };
      };
    };
    const parsed = JSON.parse(exact.body) as CapturedBody;
    assert.equal(JSON.stringify(parsed), exact.body);
    assert.equal(parsed.model, "fixture");
    assert.equal(parsed.max_tokens, 600);
    assert.equal(Array.isArray(parsed.response_format.json_schema.schema.oneOf), true);
    const userMessage = parsed.messages[1];
    assert.ok(userMessage);
    assert.ok(Array.isArray(userMessage.content));
    assert.match(userMessage.content[1]?.image_url?.url ?? "", /^data:image\/png;base64,/u);

    const fixedPromptChanged = structuredClone(parsed);
    const systemMessage = fixedPromptChanged.messages[0];
    assert.ok(systemMessage);
    assert.equal(typeof systemMessage.content, "string");
    systemMessage.content = `${systemMessage.content}\nA changed fixed instruction.`;

    const schemaChanged = structuredClone(parsed);
    schemaChanged.response_format.json_schema.schema = {
      ...schemaChanged.response_format.json_schema.schema,
      title: "changed-contract",
    };

    const modelChanged = structuredClone(parsed);
    modelChanged.model = "fixture-v2";
    const optionsChanged = structuredClone(parsed);
    optionsChanged.max_tokens += 1;

    const screenshotChanged = structuredClone(parsed);
    const screenshotMessage = screenshotChanged.messages[1];
    assert.ok(screenshotMessage);
    assert.ok(Array.isArray(screenshotMessage.content));
    const screenshotPart = screenshotMessage.content[1];
    assert.ok(screenshotPart?.image_url);
    screenshotPart.image_url.url = "data:image/png;base64,Y2hhbmdlZA==";

    for (const changed of [
      fixedPromptChanged,
      schemaChanged,
      modelChanged,
      optionsChanged,
      screenshotChanged,
    ]) {
      assert.notEqual(
        computePromptTraceHash("openai-compatible", [JSON.stringify(changed)]),
        exact.hash,
      );
    }
  });

  it("excludes postcondition-verified inputs from the generated set-value contract", async () => {
    const request = plannerRequest();
    request.allowedActions = ["set_value", "request_help"];
    request.boundInputs = ["memberId"];
    request.allowedElementRefs = {
      set_value: ["member-input"],
      activate: [],
      extract: ["balance-cell"],
    };
    const exact = await captureOpenAiRequest(request, { includeScreenshot: false });
    const parsed = JSON.parse(exact.body) as {
      messages: Array<{ content: string | Array<{ type: string; text?: string }> }>;
      response_format: { json_schema: { schema: { oneOf: unknown[] } } };
    };
    const userMessage = parsed.messages[1];
    assert.ok(userMessage && Array.isArray(userMessage.content));
    assert.match(userMessage.content[0]?.text ?? "", /"boundInputs":\["memberId"\]/u);
    assert.equal(
      JSON.stringify(parsed.response_format.json_schema.schema.oneOf).includes(
        '"kind":{"const":"set_value"}',
      ),
      false,
    );
  });

  it("is deterministic for identical exact requests and changes with dynamic request data", async () => {
    const first = await captureOpenAiRequest(plannerRequest());
    const second = await captureOpenAiRequest(plannerRequest());
    assert.equal(first.body, second.body);
    assert.equal(first.hash, second.hash);

    const changedRequest = await captureOpenAiRequest(
      plannerRequest("Exercise a different bounded planner goal."),
    );
    assert.notEqual(changedRequest.body, first.body);
    assert.notEqual(changedRequest.hash, first.hash);

    const withoutScreenshot = await captureOpenAiRequest(plannerRequest(), {
      includeScreenshot: false,
    });
    assert.notEqual(withoutScreenshot.hash, first.hash);
  });

  it("preserves ordered multi-call provenance and supports run-local trace ranges", async () => {
    const request = plannerRequest();
    const bodies: string[] = [];
    const planner = new OpenAiCompatiblePlanner({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "local-only",
      model: "fixture",
      includeScreenshot: false,
      fetchImplementation: async (_input, init) => {
        bodies.push(String(init?.body));
        return openAiHelpResponse(request.observation.id);
      },
    });

    await planner.decide(request);
    const firstCallHash = planner.promptHash;
    await planner.decide(request);

    assert.equal(planner.callCount, 2);
    assert.equal(planner.promptHash, computePromptTraceHash("openai-compatible", bodies));
    assert.equal(planner.promptHashSince(0), planner.promptHash);
    assert.equal(planner.promptHashSince(1), firstCallHash);
    assert.throws(() => planner.promptHashSince(3), /outside the recorded request range/u);
  });

  it("gives scripted and forbidden planners deterministic local trace semantics", async () => {
    const request = plannerRequest();
    const firstScripted = new ScriptedPlanner();
    const secondScripted = new ScriptedPlanner();
    await firstScripted.decide(request);
    await secondScripted.decide(plannerRequest());
    assert.equal(firstScripted.promptHash, secondScripted.promptHash);

    const changedScripted = new ScriptedPlanner();
    await changedScripted.decide(plannerRequest("A different scripted request."));
    assert.notEqual(changedScripted.promptHash, firstScripted.promptHash);

    const firstForbidden = new ThrowingPlanner();
    const secondForbidden = new ThrowingPlanner();
    assert.equal(firstForbidden.promptHash, secondForbidden.promptHash);
    const emptyForbiddenHash = firstForbidden.promptHash;
    await assert.rejects(firstForbidden.decide(request), /Replay attempted to call a model/u);
    await assert.rejects(
      secondForbidden.decide(plannerRequest()),
      /Replay attempted to call a model/u,
    );
    assert.equal(firstForbidden.callCount, 1);
    assert.equal(firstForbidden.promptHash, secondForbidden.promptHash);
    assert.notEqual(firstForbidden.promptHash, emptyForbiddenHash);
  });
});
