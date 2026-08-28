import { z } from "zod";

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{1,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PATH_TEMPLATE_PATTERN = /^\/(?!\/)(?!.*(?:\?|#|:\/\/|\\))[A-Za-z0-9._~!$&'()*+,;=:@%/{}-]*$/u;
const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(?::[1-9][0-9]{0,4})?$/u;

export const IdentifierSchema = z
  .string()
  .trim()
  .min(2)
  .max(128)
  .regex(IDENTIFIER_PATTERN)
  .describe("Stable identifier without whitespace");

export const NonEmptyTextSchema = z.string().trim().min(1).max(2_000);
export const ShortTextSchema = z.string().trim().min(1).max(280);
export const IsoTimestampSchema = z.iso.datetime({ offset: true });
export const Sha256Schema = z.string().regex(SHA256_PATTERN);
export const PathTemplateSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(PATH_TEMPLATE_PATTERN)
  .describe("A route-only path template; never an absolute URL");
export const ExactOriginSchema = z
  .string()
  .max(2_048)
  .regex(ORIGIN_PATTERN)
  .describe("An exact HTTP(S) origin with no path, query, credentials, or wildcard");

export const ClassificationSchema = z.enum(["public", "internal", "pii", "secret"]);
export type Classification = z.infer<typeof ClassificationSchema>;

export const EffectClassSchema = z.enum(["read", "reversible_write", "commit"]);
export type EffectClass = z.infer<typeof EffectClassSchema>;

export const CommandKindSchema = z.enum([
  "set_value",
  "activate",
  "press_key",
  "wait_for",
  "extract",
  "navigate",
  "capture_evidence",
]);
export type CommandKind = z.infer<typeof CommandKindSchema>;

export const SurfaceCapabilitySchema = z.enum([
  "accessibility_tree",
  "dom",
  "frames",
  "keyboard",
  "screenshot",
  "visual_anchors",
]);
export type SurfaceCapability = z.infer<typeof SurfaceCapabilitySchema>;

export const ScalarValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type ScalarValue = z.infer<typeof ScalarValueSchema>;

export const ValueValidatorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("string"),
      minLength: z.number().int().min(0).max(100_000).optional(),
      maxLength: z.number().int().min(1).max(100_000).optional(),
      pattern: z.string().min(1).max(1_024).optional(),
      enum: z.array(z.string().max(2_000)).min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("number"),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      integer: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("boolean") }).strict(),
]);
export type ValueValidator = z.infer<typeof ValueValidatorSchema>;

export const InputSpecSchema = z
  .object({
    description: ShortTextSchema,
    classification: ClassificationSchema,
    required: z.boolean(),
    validator: ValueValidatorSchema,
  })
  .strict();
export type InputSpec = z.infer<typeof InputSpecSchema>;

export const OutputSpecSchema = z
  .object({
    description: ShortTextSchema,
    classification: ClassificationSchema,
    validator: ValueValidatorSchema,
  })
  .strict();
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

export const InputValueExpressionSchema = z
  .object({
    kind: z.literal("input"),
    name: IdentifierSchema,
  })
  .strict();

export const StepOutputValueExpressionSchema = z
  .object({
    kind: z.literal("step_output"),
    stepId: IdentifierSchema,
    name: IdentifierSchema,
  })
  .strict();

export const SecretReferenceValueExpressionSchema = z
  .object({
    kind: z.literal("secret_ref"),
    name: IdentifierSchema,
  })
  .strict();

export const LiteralValueExpressionSchema = z
  .object({
    kind: z.literal("literal"),
    value: ScalarValueSchema,
    classification: ClassificationSchema,
    rationale: ShortTextSchema,
  })
  .strict();

export const ValueExpressionSchema = z.discriminatedUnion("kind", [
  InputValueExpressionSchema,
  StepOutputValueExpressionSchema,
  SecretReferenceValueExpressionSchema,
  LiteralValueExpressionSchema,
]);
export type ValueExpression = z.infer<typeof ValueExpressionSchema>;

const FramePathSchema = z.array(NonEmptyTextSchema.max(200)).max(8);

export const NormalizedRegionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
  })
  .strict()
  .refine((region) => region.x + region.width <= 1 && region.y + region.height <= 1, {
    message: "Normalized region must remain inside the surface bounds",
  });

const CandidateBaseSchema = z.object({
  framePath: FramePathSchema.optional(),
  rationale: ShortTextSchema,
});

export const RoleTargetCandidateSchema = CandidateBaseSchema.extend({
  kind: z.literal("role"),
  role: z.enum([
    "button",
    "cell",
    "checkbox",
    "combobox",
    "dialog",
    "heading",
    "link",
    "row",
    "rowheader",
    "spinbutton",
    "status",
    "tab",
    "textbox",
  ]),
  name: NonEmptyTextSchema.max(300),
  exact: z.literal(true),
}).strict();

export const LabelTargetCandidateSchema = CandidateBaseSchema.extend({
  kind: z.literal("label"),
  label: NonEmptyTextSchema.max(300),
  exact: z.literal(true),
}).strict();

export const TableTargetCandidateSchema = CandidateBaseSchema.extend({
  kind: z.literal("table"),
  rowLabel: NonEmptyTextSchema.max(300),
  columnLabel: NonEmptyTextSchema.max(300),
}).strict();

export const RelationTargetCandidateSchema = CandidateBaseSchema.extend({
  kind: z.literal("relation"),
  anchorText: NonEmptyTextSchema.max(300),
  relationship: z.enum(["labelled_control", "following", "preceding", "within", "row_value"]),
  role: z.string().trim().min(1).max(80).optional(),
}).strict();

export const AttributeTargetCandidateSchema = CandidateBaseSchema.extend({
  kind: z.literal("attribute"),
  attribute: z.string().regex(/^(?:data-[a-z0-9_.:-]+|aria-[a-z-]+)$/u),
  value: NonEmptyTextSchema.max(300),
  stabilityEvidence: ShortTextSchema,
}).strict();

export const VisualTargetCandidateSchema = CandidateBaseSchema.extend({
  kind: z.literal("visual"),
  anchorText: NonEmptyTextSchema.max(300),
  region: NormalizedRegionSchema,
  minimumConfidence: z.number().min(0.5).max(1),
}).strict();

export const TargetCandidateSchema = z.discriminatedUnion("kind", [
  RoleTargetCandidateSchema,
  LabelTargetCandidateSchema,
  TableTargetCandidateSchema,
  RelationTargetCandidateSchema,
  AttributeTargetCandidateSchema,
  VisualTargetCandidateSchema,
]);
export type TargetCandidate = z.infer<typeof TargetCandidateSchema>;

export const SemanticFingerprintSchema = z
  .object({
    role: z.string().trim().min(1).max(80).optional(),
    accessibleName: z.string().trim().min(1).max(300).optional(),
    nearbyText: z.array(NonEmptyTextSchema.max(300)).max(12).optional(),
    stableAttributes: z.record(z.string().min(1).max(100), z.string().max(300)).optional(),
    minimumScore: z.number().min(0.5).max(1),
  })
  .strict()
  .refine(
    (fingerprint) =>
      fingerprint.role !== undefined ||
      fingerprint.accessibleName !== undefined ||
      (fingerprint.nearbyText?.length ?? 0) > 0 ||
      Object.keys(fingerprint.stableAttributes ?? {}).length > 0,
    { message: "A semantic fingerprint needs at least one stable signal" },
  );

export const TargetSpecSchema = z
  .object({
    description: ShortTextSchema,
    candidates: z.array(TargetCandidateSchema).min(1).max(12),
    match: z.literal("exactly_one_visible"),
    fingerprint: SemanticFingerprintSchema,
    robustnessRationale: z.string().trim().min(12).max(1_000),
  })
  .strict();
export type TargetSpec = z.infer<typeof TargetSpecSchema>;

export const TextMatcherSchema = z
  .object({
    mode: z.enum(["exact", "contains", "regex"]),
    value: NonEmptyTextSchema.max(1_024),
    caseSensitive: z.boolean(),
  })
  .strict();

export const AtomicPredicateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("target_visible"),
      target: IdentifierSchema,
      expected: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("target_text_matches"),
      target: IdentifierSchema,
      matcher: TextMatcherSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("target_value_equals"),
      target: IdentifierSchema,
      expected: ValueExpressionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("route_matches"),
      route: PathTemplateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("output_valid"),
      output: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("surface_fingerprint"),
      minimumScore: z.number().min(0.5).max(1),
    })
    .strict(),
]);
export type AtomicPredicate = z.infer<typeof AtomicPredicateSchema>;

export const PredicateSchema = z.discriminatedUnion("kind", [
  ...AtomicPredicateSchema.options,
  z
    .object({
      kind: z.literal("all"),
      predicates: z.array(AtomicPredicateSchema).min(2).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("any"),
      predicates: z.array(AtomicPredicateSchema).min(1).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("not"),
      predicate: AtomicPredicateSchema,
    })
    .strict(),
]);
export type Predicate = z.infer<typeof PredicateSchema>;

export const ExtractorSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("target_text"),
      target: IdentifierSchema,
      transforms: z.array(z.enum(["trim", "currency_to_number", "number"])).max(4),
    })
    .strict(),
  z
    .object({
      kind: z.literal("target_value"),
      target: IdentifierSchema,
      transforms: z.array(z.enum(["trim", "currency_to_number", "number"])).max(4),
    })
    .strict(),
  z
    .object({
      kind: z.literal("target_attribute"),
      target: IdentifierSchema,
      attribute: z.string().regex(/^(?:data-[a-z0-9_.:-]+|aria-[a-z-]+)$/u),
      transforms: z.array(z.enum(["trim", "number"])).max(4),
    })
    .strict(),
]);
export type ExtractorSpec = z.infer<typeof ExtractorSpecSchema>;

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(3),
    delayMs: z.number().int().min(0).max(10_000),
    retryOn: z
      .array(z.enum(["target_not_found", "postcondition_timeout", "known_transient"]))
      .max(3),
  })
  .strict();
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

const StepBaseShape = {
  id: IdentifierSchema,
  description: ShortTextSchema,
  effect: EffectClassSchema,
  idempotency: z.enum(["idempotent", "non_idempotent"]),
  timeoutMs: z.number().int().min(100).max(30_000),
  retry: RetryPolicySchema,
  postcondition: PredicateSchema,
} as const;

export const SetValueStepSchema = z
  .object({
    ...StepBaseShape,
    command: z.literal("set_value"),
    target: IdentifierSchema,
    value: ValueExpressionSchema,
  })
  .strict();

export const ActivateStepSchema = z
  .object({
    ...StepBaseShape,
    command: z.literal("activate"),
    target: IdentifierSchema,
  })
  .strict();

export const PressKeyStepSchema = z
  .object({
    ...StepBaseShape,
    command: z.literal("press_key"),
    target: IdentifierSchema,
    key: z.enum(["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "Space"]),
  })
  .strict();

export const WaitForStepSchema = z
  .object({
    ...StepBaseShape,
    command: z.literal("wait_for"),
    condition: PredicateSchema,
  })
  .strict();

export const ExtractStepSchema = z
  .object({
    ...StepBaseShape,
    command: z.literal("extract"),
    output: IdentifierSchema,
    extractor: ExtractorSpecSchema,
  })
  .strict();

export const NavigateStepSchema = z
  .object({
    ...StepBaseShape,
    command: z.literal("navigate"),
    route: PathTemplateSchema,
  })
  .strict();

export const CaptureEvidenceStepSchema = z
  .object({
    ...StepBaseShape,
    command: z.literal("capture_evidence"),
    label: IdentifierSchema,
  })
  .strict();

export const StepSchema = z.discriminatedUnion("command", [
  SetValueStepSchema,
  ActivateStepSchema,
  PressKeyStepSchema,
  WaitForStepSchema,
  ExtractStepSchema,
  NavigateStepSchema,
  CaptureEvidenceStepSchema,
]);
export type Step = z.infer<typeof StepSchema>;

export const KnownOutcomeSpecSchema = z
  .object({
    code: IdentifierSchema,
    description: ShortTextSchema,
    when: PredicateSchema,
  })
  .strict();
export type KnownOutcomeSpec = z.infer<typeof KnownOutcomeSpecSchema>;

export const FingerprintSignalSchema = z
  .object({
    kind: z.enum(["route", "heading", "frame", "marker", "version"]),
    value: NonEmptyTextSchema.max(500),
    weight: z.number().gt(0).max(1),
  })
  .strict();

export const FingerprintRuleSchema = z
  .object({
    signals: z.array(FingerprintSignalSchema).min(1).max(30),
    minimumScore: z.number().gt(0).max(1),
  })
  .strict();
export type FingerprintRule = z.infer<typeof FingerprintRuleSchema>;

export const CapabilityPolicyRequirementsSchema = z
  .object({
    allowedRoutes: z.array(PathTemplateSchema).min(1).max(100),
    allowedCommands: z.array(CommandKindSchema).min(1).max(CommandKindSchema.options.length),
    allowedEffects: z.array(EffectClassSchema).min(1).max(EffectClassSchema.options.length),
    approvalRequiredFor: z.array(EffectClassSchema).max(EffectClassSchema.options.length),
  })
  .strict();
export type CapabilityPolicyRequirements = z.infer<typeof CapabilityPolicyRequirementsSchema>;

export const CapabilityArtifactSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: IdentifierSchema,
    revision: z.number().int().min(1),
    name: z.string().trim().min(3).max(120),
    description: z.string().trim().min(12).max(2_000),
    purpose: z.string().trim().min(12).max(1_000),
    digest: Sha256Schema,
    compatibility: z
      .object({
        product: z
          .object({
            vendor: NonEmptyTextSchema.max(120),
            product: NonEmptyTextSchema.max(120),
            versionRange: z.string().trim().min(1).max(120).optional(),
          })
          .strict(),
        requiredSurfaceCapabilities: z.array(SurfaceCapabilitySchema).min(1),
        fingerprint: FingerprintRuleSchema,
      })
      .strict(),
    entrypoint: z
      .object({
        bindingKey: IdentifierSchema,
        route: PathTemplateSchema.optional(),
      })
      .strict(),
    contract: z
      .object({
        inputs: z.record(IdentifierSchema, InputSpecSchema),
        outputs: z.record(IdentifierSchema, OutputSpecSchema),
        outcomes: z.array(KnownOutcomeSpecSchema).max(30),
      })
      .strict(),
    targets: z.record(IdentifierSchema, TargetSpecSchema),
    effects: z.array(EffectClassSchema).min(1).max(EffectClassSchema.options.length),
    policyRequirements: CapabilityPolicyRequirementsSchema,
    steps: z.array(StepSchema).min(1).max(200),
    success: PredicateSchema,
    provenance: z
      .object({
        discoveryRunId: IdentifierSchema,
        provider: NonEmptyTextSchema.max(120),
        modelId: NonEmptyTextSchema.max(200),
        promptHash: Sha256Schema,
        liveModel: z.boolean(),
        createdAt: IsoTimestampSchema,
      })
      .strict(),
  })
  .strict();
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
export const CapabilityArtifactDraftSchema = CapabilityArtifactSchema.omit({ digest: true });
export type CapabilityArtifactDraft = z.infer<typeof CapabilityArtifactDraftSchema>;

export const ArtifactApprovalSchema = z
  .object({
    artifactId: IdentifierSchema,
    revision: z.number().int().min(1),
    digest: Sha256Schema,
    approvedBy: IdentifierSchema,
    approvedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema.optional(),
  })
  .strict();
export type ArtifactApproval = z.infer<typeof ArtifactApprovalSchema>;

export const SecretBindingSchema = z
  .object({
    brokerKey: IdentifierSchema,
    purpose: ShortTextSchema,
  })
  .strict();

export const BindingPolicySchema = z
  .object({
    allowedOrigins: z.array(ExactOriginSchema).min(1).max(20),
    allowedRoutes: z.array(PathTemplateSchema).min(1).max(100),
    allowedCommands: z.array(CommandKindSchema).min(1).max(CommandKindSchema.options.length),
    allowedEffects: z.array(EffectClassSchema).min(1).max(EffectClassSchema.options.length),
  })
  .strict();

export const AppBindingSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    id: IdentifierSchema,
    product: z
      .object({
        vendor: NonEmptyTextSchema.max(120),
        product: NonEmptyTextSchema.max(120),
        tenantLabel: NonEmptyTextSchema.max(120),
      })
      .strict(),
    origin: ExactOriginSchema,
    entrypoints: z.record(IdentifierSchema, PathTemplateSchema),
    secretRefs: z.record(IdentifierSchema, SecretBindingSchema),
    expectedFingerprint: FingerprintRuleSchema,
    targetOverrides: z.record(IdentifierSchema, TargetSpecSchema),
    policy: BindingPolicySchema,
  })
  .strict();
export type AppBinding = z.infer<typeof AppBindingSchema>;

const ModelDecisionBaseShape = {
  decisionId: IdentifierSchema,
  observationId: IdentifierSchema,
  rationale: ShortTextSchema,
} as const;

export const ModelDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...ModelDecisionBaseShape,
      kind: z.literal("set_value"),
      elementRef: IdentifierSchema,
      value: ValueExpressionSchema,
    })
    .strict(),
  z
    .object({
      ...ModelDecisionBaseShape,
      kind: z.literal("activate"),
      elementRef: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      ...ModelDecisionBaseShape,
      kind: z.literal("activate_coordinate"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      ...ModelDecisionBaseShape,
      kind: z.literal("wait"),
      durationMs: z.number().int().min(50).max(5_000),
    })
    .strict(),
  z
    .object({
      ...ModelDecisionBaseShape,
      kind: z.literal("extract"),
      elementRef: IdentifierSchema,
      output: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      ...ModelDecisionBaseShape,
      kind: z.literal("finish"),
      summary: ShortTextSchema,
    })
    .strict(),
  z
    .object({
      ...ModelDecisionBaseShape,
      kind: z.literal("request_help"),
      reason: z.enum(["stuck", "unsafe", "expired_session", "risky", "unknown_state"]),
      summary: ShortTextSchema,
    })
    .strict(),
]);
export type ModelDecision = z.infer<typeof ModelDecisionSchema>;

export const EvidenceRefSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum(["screenshot", "surface_snapshot", "event_log", "artifact", "summary"]),
    relativePath: z
      .string()
      .min(1)
      .max(1_024)
      .refine((path) => !path.startsWith("/") && !path.includes("..")),
    sha256: Sha256Schema,
    byteLength: z.number().int().min(0),
    mimeType: z.string().trim().min(3).max(120),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const FaultCodeSchema = z.enum([
  "ARTIFACT_INVALID",
  "ARTIFACT_DIGEST_MISMATCH",
  "INPUT_INVALID",
  "INCOMPATIBLE_SURFACE",
  "POLICY_DENIED",
  "PERMISSION_DENIED",
  "TARGET_NOT_FOUND",
  "TARGET_AMBIGUOUS",
  "POSTCONDITION_FAILED",
  "RECOVERY_EXHAUSTED",
  "CONTROL_LOST",
  "SESSION_LOST",
  "MODEL_INVALID_DECISION",
  "MODEL_UNAVAILABLE",
  "DEAD_END",
  "MAX_STEPS",
  "RUN_TIMEOUT",
  "UNKNOWN_DIALOG",
  "INTERNAL_ERROR",
]);
export type FaultCode = z.infer<typeof FaultCodeSchema>;

export const AutomationFaultSchema = z
  .object({
    code: FaultCodeSchema,
    message: z.string().trim().min(1).max(2_000),
    phase: z.enum(["preflight", "discovery", "replay", "handoff", "evidence"]),
    retryable: z.boolean(),
    stepId: IdentifierSchema.optional(),
    expected: z.string().max(2_000).optional(),
    observed: z.string().max(2_000).optional(),
    evidence: z.array(EvidenceRefSchema).max(20),
  })
  .strict();
export type AutomationFault = z.infer<typeof AutomationFaultSchema>;

export const InterventionReasonSchema = z.enum([
  "STUCK",
  "UNSAFE_ACTION",
  "SESSION_EXPIRED",
  "RISK_APPROVAL_REQUIRED",
  "UNKNOWN_STATE",
]);

export const InterventionViewSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    sessionId: IdentifierSchema,
    reason: InterventionReasonSchema,
    summary: z.string().trim().min(1).max(2_000),
    currentStepId: IdentifierSchema.optional(),
    observedState: z.string().trim().min(1).max(2_000),
    allowedActions: z
      .array(
        z.enum(["claim", "activate", "type", "press_key", "capture_evidence", "resume", "abort"]),
      )
      .min(1),
    evidence: z.array(EvidenceRefSchema).max(20),
    ownerEpoch: z.number().int().min(0),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type InterventionView = z.infer<typeof InterventionViewSchema>;

export const RunMetaSchema = z
  .object({
    runId: IdentifierSchema,
    artifactId: IdentifierSchema,
    artifactDigest: Sha256Schema,
    sessionId: IdentifierSchema,
    startedAt: IsoTimestampSchema,
    finishedAt: IsoTimestampSchema,
    durationMs: z.number().int().min(0),
    modelCalls: z.number().int().min(0),
    ownerEpoch: z.number().int().min(0),
  })
  .strict();
export type RunMeta = z.infer<typeof RunMetaSchema>;

export const KnownOutcomeSchema = z
  .object({
    code: IdentifierSchema,
    message: z.string().trim().min(1).max(2_000),
    details: z.record(z.string().max(100), z.json()),
  })
  .strict();
export type KnownOutcome = z.infer<typeof KnownOutcomeSchema>;

export const RunResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("succeeded"),
      outputs: z.record(IdentifierSchema, z.json()),
      checkpointEvidence: z.array(EvidenceRefSchema),
      meta: RunMetaSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("business_outcome"),
      outcome: KnownOutcomeSchema,
      evidence: z.array(EvidenceRefSchema),
      meta: RunMetaSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("needs_intervention"),
      intervention: InterventionViewSchema,
      meta: RunMetaSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      error: AutomationFaultSchema,
      meta: RunMetaSchema,
    })
    .strict(),
]);
export type RunResult = z.infer<typeof RunResultSchema>;

const EventBaseShape = {
  schemaVersion: z.literal("1.0.0"),
  eventId: IdentifierSchema,
  sequence: z.number().int().min(0),
  timestamp: IsoTimestampSchema,
  runId: IdentifierSchema,
  correlationId: IdentifierSchema,
  sessionId: IdentifierSchema.optional(),
  artifactId: IdentifierSchema.optional(),
  actor: z.enum(["automation", "model", "operator", "system"]),
  ownerEpoch: z.number().int().min(0),
} as const;

export const AutomationEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...EventBaseShape,
      type: z.literal("run.started"),
      mode: z.enum(["discovery", "replay"]),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("observation.captured"),
      observationId: IdentifierSchema,
      route: PathTemplateSchema,
      surfaceFingerprint: Sha256Schema,
      summary: ShortTextSchema,
      evidenceId: IdentifierSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("model.decision"),
      provider: NonEmptyTextSchema.max(120),
      modelId: NonEmptyTextSchema.max(200),
      decision: ModelDecisionSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("action.dispatched"),
      command: CommandKindSchema,
      effect: EffectClassSchema,
      stepId: IdentifierSchema.optional(),
      target: IdentifierSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("action.completed"),
      command: CommandKindSchema,
      stepId: IdentifierSchema.optional(),
      durationMs: z.number().int().min(0),
      changedSurface: z.boolean(),
      receiptSummary: ShortTextSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("predicate.evaluated"),
      predicate: PredicateSchema,
      passed: z.boolean(),
      observedSummary: ShortTextSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("intervention.created"),
      intervention: InterventionViewSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("control.transferred"),
      from: z.enum(["automation", "operator", "none"]),
      to: z.enum(["automation", "operator", "none"]),
      reason: ShortTextSchema,
      newOwnerEpoch: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("fault.raised"),
      fault: AutomationFaultSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("evidence.captured"),
      evidence: EvidenceRefSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      type: z.literal("run.completed"),
      status: z.enum(["succeeded", "business_outcome", "needs_intervention", "failed"]),
      durationMs: z.number().int().min(0),
      modelCalls: z.number().int().min(0),
    })
    .strict(),
]);
export type AutomationEvent = z.infer<typeof AutomationEventSchema>;

/** JSON Schemas are generated from the same runtime contracts used by the code. */
export const CapabilityArtifactJsonSchema = z.toJSONSchema(CapabilityArtifactSchema, {
  target: "draft-2020-12",
});
export const AppBindingJsonSchema = z.toJSONSchema(AppBindingSchema, {
  target: "draft-2020-12",
});
export const ModelDecisionJsonSchema = z.toJSONSchema(ModelDecisionSchema, {
  target: "draft-2020-12",
});
export const AutomationEventJsonSchema = z.toJSONSchema(AutomationEventSchema, {
  target: "draft-2020-12",
});
export const InterventionJsonSchema = z.toJSONSchema(InterventionViewSchema, {
  target: "draft-2020-12",
});
export const RunResultJsonSchema = z.toJSONSchema(RunResultSchema, {
  target: "draft-2020-12",
});

export const RuntimeJsonSchemas = Object.freeze({
  capabilityArtifact: CapabilityArtifactJsonSchema,
  appBinding: AppBindingJsonSchema,
  modelDecision: ModelDecisionJsonSchema,
  automationEvent: AutomationEventJsonSchema,
  intervention: InterventionJsonSchema,
  runResult: RunResultJsonSchema,
});
