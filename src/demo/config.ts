import {
  type AppBinding,
  AppBindingSchema,
  type CapabilityPolicyRequirements,
} from "../domain/schema.js";
import {
  bindingPolicyLayer,
  capabilityPolicyLayer,
  type PolicyLayer,
  type PolicyStack,
} from "../runtime/policy.js";

export const DEMO_GOAL =
  "Look up the member by member number and return the current balance for the Savings account.";

export const DEMO_INPUTS = Object.freeze({ memberId: "84721" });

export const DEMO_CAPABILITY_POLICY: CapabilityPolicyRequirements = {
  allowedRoutes: ["/legacy", "/legacy/**"],
  allowedCommands: ["navigate", "set_value", "activate", "extract", "capture_evidence"],
  allowedEffects: ["read", "reversible_write"],
  approvalRequiredFor: [],
};

export function createDemoBinding(
  origin: string,
  tenantLabel = "Northstar synthetic tenant",
): AppBinding {
  return AppBindingSchema.parse({
    schemaVersion: "1.0.0",
    id: "member-services",
    product: {
      vendor: "Handrail Labs",
      product: "Synthetic Legacy Member Services",
      tenantLabel,
    },
    origin,
    entrypoints: { memberSearch: "/legacy" },
    secretRefs: {},
    expectedFingerprint: {
      signals: [
        { kind: "route", value: "/legacy", weight: 0.4 },
        { kind: "frame", value: "member-workspace", weight: 0.3 },
        { kind: "marker", value: "SYNTHETIC DATA", weight: 0.3 },
      ],
      minimumScore: 0.7,
    },
    targetOverrides: {},
    policy: {
      allowedOrigins: [origin],
      allowedRoutes: ["/legacy", "/legacy/**"],
      allowedCommands: [
        "navigate",
        "set_value",
        "activate",
        "press_key",
        "wait_for",
        "extract",
        "capture_evidence",
      ],
      allowedEffects: ["read", "reversible_write"],
    },
  });
}

export function createDemoPolicyStack(
  binding: AppBinding,
  capability = DEMO_CAPABILITY_POLICY,
): PolicyStack {
  const platform: PolicyLayer = {
    name: "platform",
    allowedOrigins: [binding.origin],
    allowedRoutes: ["/legacy", "/legacy/**"],
    allowedCommands: [
      "navigate",
      "set_value",
      "activate",
      "press_key",
      "wait_for",
      "extract",
      "capture_evidence",
      "request_help",
      "finish",
      "claim",
      "resume",
      "activate_coordinate",
      "type",
      "abort",
    ],
    allowedEffects: ["read", "reversible_write"],
    approvalRequiredFor: ["commit"],
  };
  return {
    platform,
    binding: bindingPolicyLayer(binding),
    capability: capabilityPolicyLayer(capability),
  };
}
