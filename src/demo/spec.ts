import type { AppBinding, TargetSpec } from "../domain/schema.js";
import type {
  DiscoveryArtifactSpec,
  DiscoveryRequest,
  DiscoverySentinel,
} from "../runtime/discovery.js";
import type { ReplaySurfaceSentinel } from "../runtime/replay.js";
import { DEMO_CAPABILITY_POLICY, DEMO_GOAL, DEMO_INPUTS } from "./config.js";

export const MEMBER_NOT_FOUND_TARGET: TargetSpec = {
  description: "The stable member-search business outcome message.",
  candidates: [
    {
      kind: "role",
      role: "status",
      name: "Member search result",
      exact: true,
      framePath: ["name:member-workspace"],
      rationale: "A stable application-authored status name identifies the business outcome.",
    },
    {
      kind: "visual",
      anchorText: "Member search result",
      region: { x: 0.02, y: 0.35, width: 0.94, height: 0.1 },
      minimumConfidence: 0.85,
      framePath: ["name:member-workspace"],
      rationale: "A narrow status band is the final fallback for the sparse legacy surface.",
    },
  ],
  match: "exactly_one_visible",
  fingerprint: {
    role: "status",
    accessibleName: "Member search result",
    nearbyText: ["No member found."],
    minimumScore: 0.6,
  },
  robustnessRationale:
    "The application-authored status identity is primary and the bounded message region is a fail-closed fallback.",
};

export const DEMO_ARTIFACT_SPEC: DiscoveryArtifactSpec = {
  id: "member.balance.lookup",
  revision: 1,
  name: "Member savings balance lookup",
  description:
    "Look up a member in the synthetic legacy servicing workspace and return the current Savings balance.",
  purpose:
    "Demonstrate discover-once, deterministic replay, typed output extraction, and explicit business outcomes.",
  entrypointKey: "memberSearch",
  inputs: {
    memberId: {
      description: "Five-digit synthetic member number supplied at invocation time.",
      classification: "pii",
      required: true,
      validator: { kind: "string", minLength: 5, maxLength: 5, pattern: "^[0-9]{5}$" },
    },
  },
  outputs: {
    savingsBalance: {
      description: "Current balance of the member's Savings account as a number.",
      classification: "internal",
      validator: { kind: "number", minimum: 0 },
    },
  },
  outcomes: [
    {
      code: "MEMBER_NOT_FOUND",
      description: "No synthetic member matched the supplied member number.",
      when: {
        kind: "target_text_matches",
        target: "member-not-found",
        matcher: { mode: "exact", value: "No member found.", caseSensitive: false },
      },
    },
  ],
  staticTargets: { "member-not-found": MEMBER_NOT_FOUND_TARGET },
  outputBindings: {
    savingsBalance: { source: "text", transforms: ["trim", "currency_to_number"] },
  },
  activationPolicies: [
    {
      role: "button",
      name: "Find Member",
      effect: "read",
      idempotency: "idempotent",
    },
  ],
  versionRange: ">=1 <2",
  requiredSurfaceCapabilities: [
    "accessibility_tree",
    "dom",
    "frames",
    "keyboard",
    "screenshot",
    "visual_anchors",
  ],
  policyRequirements: DEMO_CAPABILITY_POLICY,
};

export const DEMO_SENTINELS: readonly DiscoverySentinel[] = [
  {
    kind: "recoverable",
    code: "KNOWN_TRANSIENT_LOAD",
    pattern: /Loading member record\. Please wait/iu,
    summary: "The known synthetic loading state is still in progress.",
  },
  {
    kind: "intervention",
    reason: "SESSION_EXPIRED",
    pattern: /Your session has expired/iu,
    summary: "Session expired - manual recovery required",
  },
  {
    kind: "hard_failure",
    code: "PERMISSION_DENIED",
    pattern: /Access denied.*cannot view/isu,
    message: "The application denied permission to the requested synthetic member.",
    retryable: false,
  },
  {
    kind: "hard_failure",
    code: "INTERNAL_ERROR",
    pattern: /Application error E-500/iu,
    message: "The synthetic member service reported a hard application error.",
    retryable: false,
  },
];

export const DEMO_REPLAY_SENTINELS: readonly ReplaySurfaceSentinel[] = [
  {
    kind: "recoverable",
    code: "KNOWN_TRANSIENT_LOAD",
    pattern: /Loading member record\. Please wait/iu,
    summary: "The known synthetic loading state exceeded its bounded wait.",
    maxChecks: 25,
    delayMs: 100,
  },
  {
    kind: "intervention",
    reason: "SESSION_EXPIRED",
    pattern: /Your session has expired/iu,
    message: "Session expired - manual recovery required",
  },
  {
    kind: "hard_failure",
    code: "PERMISSION_DENIED",
    pattern: /Access denied.*cannot view/isu,
    message: "The application denied permission to the requested synthetic member.",
  },
  {
    kind: "hard_failure",
    code: "INTERNAL_ERROR",
    pattern: /Application error E-500/iu,
    message: "The synthetic member service reported a hard application error.",
  },
];

export function createDemoDiscoveryRequest(
  binding: AppBinding,
  targetUrl: string,
  options: Partial<
    Pick<
      DiscoveryRequest,
      | "goal"
      | "runId"
      | "retainSession"
      | "persistObservationScreenshots"
      | "screenshotsRedactionVerified"
      | "artifactEvidencePath"
    >
  > = {},
): DiscoveryRequest {
  return {
    goal: DEMO_GOAL,
    targetUrl,
    binding,
    inputs: DEMO_INPUTS,
    artifact: DEMO_ARTIFACT_SPEC,
    sentinels: DEMO_SENTINELS,
    maxSteps: 12,
    timeoutMs: 120_000,
    maxRecoveries: 4,
    recoveryDelayMs: 400,
    ...options,
  };
}
