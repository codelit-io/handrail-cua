import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type BoundApproval,
  checkPolicy,
  enforcePolicy,
  normalizeExactOrigin,
  PolicyDeniedError,
  type PolicyRequest,
  type PolicyStack,
  routeMatches,
} from "../src/runtime/policy.js";

const future = "2035-01-01T00:00:00.000Z";
const now = "2030-01-01T00:00:00.000Z";

const policy: PolicyStack = {
  platform: {
    name: "platform",
    allowedOrigins: ["http://127.0.0.1:4312"],
    allowedRoutes: ["/**"],
    allowedActions: ["set_value", "activate", "extract"],
    allowedEffects: ["read", "reversible_write", "commit"],
  },
  binding: {
    name: "binding",
    allowedOrigins: ["http://127.0.0.1:4312"],
    allowedRoutes: ["/legacy/**"],
    allowedActions: ["set_value", "activate", "extract"],
    allowedEffects: ["read", "reversible_write"],
  },
  capability: {
    name: "capability",
    allowedRoutes: ["/legacy/members/{memberId}"],
    allowedActions: ["set_value", "activate", "extract"],
    allowedEffects: ["read", "reversible_write"],
  },
};

function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    url: "http://127.0.0.1:4312/legacy/members/SYN-1002?demo=true#ignored",
    action: "extract",
    effect: "read",
    actor: "replay",
    runId: "run-001",
    now,
    ...overrides,
  };
}

describe("exact runtime policy", () => {
  it("requires every policy layer to allow the exact origin, route, action, and effect", () => {
    const decision = checkPolicy(policy, request());
    assert.equal(decision.allowed, true);
    if (!decision.allowed) {
      return;
    }
    assert.equal(decision.origin, "http://127.0.0.1:4312");
    assert.equal(decision.route, "/legacy/members/SYN-1002");
    assert.deepEqual(decision.matchedRoutes, {
      platform: "/**",
      binding: "/legacy/**",
      capability: "/legacy/members/{memberId}",
    });
  });

  it("uses the schema command vocabulary while retaining the action alias", () => {
    const commandPolicy: PolicyStack = {
      platform: { name: "platform", allowedCommands: ["extract"] },
      binding: { name: "binding", allowedCommands: ["extract"] },
      capability: { name: "capability", allowedCommands: ["extract"] },
    };
    const decision = checkPolicy(commandPolicy, {
      url: "http://127.0.0.1:4312/legacy/members/SYN-1002",
      command: "extract",
      effect: "read",
      actor: "replay",
      runId: "run-001",
      now,
    });
    assert.equal(decision.allowed, true);
    if (decision.allowed) {
      assert.equal(decision.command, "extract");
      assert.equal(decision.action, "extract");
    }
  });

  it("blocks lookalike hosts, scheme changes, and port changes", () => {
    for (const url of [
      "http://127.0.0.1.evil.test:4312/legacy/members/SYN-1002",
      "https://127.0.0.1:4312/legacy/members/SYN-1002",
      "http://127.0.0.1:4313/legacy/members/SYN-1002",
    ]) {
      const decision = checkPolicy(policy, request({ url }));
      assert.equal(decision.allowed, false);
      if (!decision.allowed) {
        assert.equal(decision.code, "ORIGIN_DENIED");
      }
    }
  });

  it("fails closed after an off-origin redirect", () => {
    assert.throws(
      () =>
        enforcePolicy(policy, request({ url: "https://outside.invalid/legacy/members/SYN-1002" })),
      (error: unknown) =>
        error instanceof PolicyDeniedError && error.decision.code === "ORIGIN_DENIED",
    );
  });

  it("blocks sibling routes, partial segments, disallowed actions, and disallowed effects", () => {
    const cases: readonly [Partial<PolicyRequest>, string][] = [
      [{ url: "http://127.0.0.1:4312/legacy/admin" }, "ROUTE_DENIED"],
      [{ url: "http://127.0.0.1:4312/legacy/members/SYN-1002/details" }, "ROUTE_DENIED"],
      [{ url: "http://127.0.0.1:4312/legacy/members%2fadmin" }, "POLICY_INVALID"],
      [{ action: "navigate" }, "ACTION_DENIED"],
      [{ effect: "commit" }, "EFFECT_DENIED"],
    ];
    for (const [overrides, code] of cases) {
      const decision = checkPolicy(policy, request(overrides));
      assert.equal(decision.allowed, false);
      if (!decision.allowed) {
        assert.equal(decision.code, code);
      }
    }
  });

  it("does not turn permissions from different layers into a union", () => {
    const splitPolicy: PolicyStack = {
      platform: { name: "platform", allowedActions: ["activate"] },
      binding: { name: "binding", allowedActions: ["extract"] },
      capability: { name: "capability", allowedActions: ["activate", "extract"] },
    };
    const decision = checkPolicy(splitPolicy, request({ action: "activate" }));
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.code, "ACTION_DENIED");
      assert.equal(decision.layer, "binding");
    }
  });

  it("treats an explicit empty allowlist as deny-all", () => {
    const decision = checkPolicy(
      [{ name: "deny-all", allowedOrigins: [], allowedRoutes: [], allowedActions: [] }],
      request(),
    );
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.code, "ORIGIN_DENIED");
    }
  });

  it("rejects invalid configured origins and route patterns", () => {
    const invalidPolicies = [
      [{ name: "wildcard", allowedOrigins: ["https://*.example.test"] }],
      [{ name: "path", allowedOrigins: ["https://example.test/path"] }],
      [{ name: "route", allowedRoutes: ["/legacy/**/admin"] }],
      [{ name: "route", allowedRoutes: ["https://example.test/legacy"] }],
      [{ name: "route", allowedRoutes: ["/legacy//member"] }],
    ] as const;
    for (const layers of invalidPolicies) {
      const decision = checkPolicy(layers, request());
      assert.equal(decision.allowed, false);
      if (!decision.allowed) {
        assert.equal(decision.code, "POLICY_INVALID");
      }
    }
  });
});

describe("route templates", () => {
  it("matches exact paths and bounded placeholders", () => {
    assert.equal(routeMatches("/legacy/members/{memberId}", "/legacy/members/SYN-1"), true);
    assert.equal(routeMatches("/legacy/members/:memberId", "/legacy/members/SYN-1"), true);
    assert.equal(routeMatches("/legacy/*/summary", "/legacy/member/summary"), true);
    assert.equal(routeMatches("/legacy/**", "/legacy/member/SYN-1/summary"), true);
    assert.equal(routeMatches("/legacy/*", "/legacy/member/summary"), false);
    assert.equal(routeMatches("/legacy/{id}", "/legacy/"), false);
    assert.equal(routeMatches("/legacy/{id}", "/legacy/SYN-1/summary"), false);
    assert.equal(routeMatches("/legacy/{id}", "/legacy/SYN%2Fadmin"), false);
  });

  it("normalizes only exact origins", () => {
    assert.equal(normalizeExactOrigin("HTTPS://EXAMPLE.TEST:443/"), "https://example.test");
    assert.equal(normalizeExactOrigin("https://example.test/path"), undefined);
    assert.equal(normalizeExactOrigin("https://user:pass@example.test"), undefined);
    assert.equal(normalizeExactOrigin("file:///tmp/demo"), undefined);
  });
});

describe("effect authorization", () => {
  const commitPolicy: PolicyStack = {
    platform: {
      name: "platform",
      allowedOrigins: ["https://bank.synthetic"],
      allowedRoutes: ["/transfers/{id}"],
      allowedActions: ["activate"],
      allowedEffects: ["commit"],
    },
    binding: {
      name: "binding",
      allowedOrigins: ["https://bank.synthetic"],
      allowedRoutes: ["/transfers/{id}"],
      allowedActions: ["activate"],
      allowedEffects: ["commit"],
    },
    capability: {
      name: "capability",
      allowedRoutes: ["/transfers/{id}"],
      allowedActions: ["activate"],
      allowedEffects: ["commit"],
    },
  };

  const commitRequest: PolicyRequest = {
    url: "https://bank.synthetic/transfers/T-1",
    action: "activate",
    effect: "commit",
    actor: "replay",
    runId: "run-commit",
    operationId: "submit-transfer",
    capabilityDigest: "a".repeat(64),
    now,
  };

  it("requires approval for commit even when every layer allows the effect", () => {
    const decision = checkPolicy(commitPolicy, commitRequest);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.code, "APPROVAL_REQUIRED");
    }
  });

  it("accepts only an unexpired approval bound to the exact operation", () => {
    const approval = {
      id: "approval-1",
      runId: "run-commit",
      operationId: "submit-transfer",
      action: "activate",
      effect: "commit",
      origin: "https://bank.synthetic",
      route: "/transfers/T-1",
      expiresAt: future,
      capabilityDigest: "a".repeat(64),
    } as const;
    const decision = checkPolicy(commitPolicy, { ...commitRequest, approval });
    assert.equal(decision.allowed, true);
    if (decision.allowed) {
      assert.equal(decision.authorization, "bound_approval");
    }

    const badApprovals: readonly BoundApproval[] = [
      { ...approval, runId: "another-run" },
      { ...approval, operationId: "confirm-another-transfer" },
      { ...approval, route: "/transfers/T-2" },
      { ...approval, action: "extract" },
      { ...approval, expiresAt: "2020-01-01T00:00:00.000Z" },
      { ...approval, capabilityDigest: "b".repeat(64) },
    ];
    for (const badApproval of badApprovals) {
      const denied = checkPolicy(commitPolicy, { ...commitRequest, approval: badApproval });
      assert.equal(denied.allowed, false);
      if (!denied.allowed) {
        assert.equal(denied.code, "APPROVAL_INVALID");
      }
    }

    const wrongOperation = checkPolicy(commitPolicy, {
      ...commitRequest,
      operationId: "confirm-another-transfer",
      approval,
    });
    assert.equal(wrongOperation.allowed, false);
    if (!wrongOperation.allowed) {
      assert.equal(wrongOperation.code, "APPROVAL_INVALID");
    }
  });

  it("accepts a human grant only for the exact operator session epoch", () => {
    const operatorRequest: PolicyRequest = {
      ...commitRequest,
      actor: "operator",
      sessionId: "surface-session-1",
      ownerEpoch: 7,
      humanGrant: {
        id: "grant-1",
        runId: "run-commit",
        sessionId: "surface-session-1",
        ownerEpoch: 7,
        expiresAt: future,
      },
    };
    const granted = checkPolicy(commitPolicy, operatorRequest);
    assert.equal(granted.allowed, true);
    if (granted.allowed) {
      assert.equal(granted.authorization, "human_control");
    }

    const stale = checkPolicy(commitPolicy, { ...operatorRequest, ownerEpoch: 8 });
    assert.equal(stale.allowed, false);
    if (!stale.allowed) {
      assert.equal(stale.code, "APPROVAL_INVALID");
    }

    const automation = checkPolicy(commitPolicy, { ...operatorRequest, actor: "replay" });
    assert.equal(automation.allowed, false);
  });
});
