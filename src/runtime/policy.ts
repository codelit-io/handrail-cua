/**
 * Fail-closed runtime policy checks.
 *
 * Policy layers are evaluated independently. A request must satisfy every layer;
 * permissions are never unioned across platform, binding, and capability policy.
 */

import type {
  AppBinding,
  CapabilityPolicyRequirements,
  CommandKind,
  EffectClass,
} from "../domain/schema.js";

export type PolicyActor = "discovery" | "replay" | "operator" | "system";
export type RuntimeCommand =
  | CommandKind
  | "abort"
  | "activate_coordinate"
  | "claim"
  | "finish"
  | "request_help"
  | "resume"
  | "type";

export interface PolicyLayer {
  readonly name: string;
  /** Exact HTTP(S) origins. Wildcards and origins containing paths are invalid. */
  readonly allowedOrigins?: readonly string[];
  /** Path templates. Supported placeholders are `{name}`, `:name`, `*`, and terminal `**`. */
  readonly allowedRoutes?: readonly string[];
  readonly allowedCommands?: readonly RuntimeCommand[];
  /** Backwards-compatible vocabulary; when both are present, both must allow the command. */
  readonly allowedActions?: readonly RuntimeCommand[];
  readonly allowedEffects?: readonly EffectClass[];
  readonly approvalRequiredFor?: readonly EffectClass[];
}

export interface PolicyStack {
  readonly platform: PolicyLayer;
  readonly binding: PolicyLayer;
  readonly capability: PolicyLayer;
}

export interface BoundApproval {
  readonly id: string;
  readonly runId: string;
  readonly command?: RuntimeCommand;
  /** Backwards-compatible alias for command. */
  readonly action?: RuntimeCommand;
  readonly effect: EffectClass;
  readonly origin: string;
  readonly route: string;
  readonly expiresAt: string | number | Date;
  readonly capabilityDigest?: string;
}

export interface HumanControlGrant {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly ownerEpoch: number;
  readonly expiresAt: string | number | Date;
}

export interface PolicyRequest {
  readonly url: string | URL;
  readonly command?: RuntimeCommand;
  /** Backwards-compatible alias for command. */
  readonly action?: RuntimeCommand;
  readonly effect: EffectClass;
  readonly actor: PolicyActor;
  readonly runId: string;
  readonly capabilityDigest?: string;
  readonly sessionId?: string;
  readonly ownerEpoch?: number;
  readonly approval?: BoundApproval;
  readonly humanGrant?: HumanControlGrant;
  /** Injectable for deterministic expiry tests. */
  readonly now?: string | number | Date;
}

export type PolicyDenialCode =
  | "POLICY_INVALID"
  | "ORIGIN_DENIED"
  | "ROUTE_DENIED"
  | "ACTION_DENIED"
  | "EFFECT_DENIED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID";

export interface PolicyGrant {
  readonly allowed: true;
  readonly origin: string;
  readonly route: string;
  readonly command: RuntimeCommand;
  /** Backwards-compatible alias for command. */
  readonly action: RuntimeCommand;
  readonly effect: EffectClass;
  readonly authorization: "policy" | "bound_approval" | "human_control";
  readonly matchedRoutes: Readonly<Record<string, string>>;
}

export interface PolicyDenial {
  readonly allowed: false;
  readonly code: PolicyDenialCode;
  readonly summary: string;
  readonly layer?: string;
}

export type PolicyDecision = PolicyGrant | PolicyDenial;

const ORIGIN_PROTOCOLS = new Set(["http:", "https:"]);
const EFFECT_CLASSES = new Set<EffectClass>(["read", "reversible_write", "commit"]);
const RUNTIME_COMMANDS = new Set<RuntimeCommand>([
  "abort",
  "activate",
  "activate_coordinate",
  "capture_evidence",
  "claim",
  "extract",
  "finish",
  "navigate",
  "press_key",
  "request_help",
  "resume",
  "set_value",
  "type",
  "wait_for",
]);
const MAX_ROUTE_PATTERN_LENGTH = 1_024;

function layersOf(policy: PolicyStack | readonly PolicyLayer[]): readonly PolicyLayer[] {
  return "platform" in policy ? [policy.platform, policy.binding, policy.capability] : policy;
}

function parseRequestUrl(input: string | URL): URL | undefined {
  try {
    const parsed = input instanceof URL ? new URL(input.href) : new URL(input);
    if (
      !ORIGIN_PROTOCOLS.has(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      /%(?:00|2f|5c)/iu.test(parsed.pathname)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function requestCommand(request: PolicyRequest): RuntimeCommand | undefined {
  if (request.command && request.action && request.command !== request.action) {
    return undefined;
  }
  return request.command ?? request.action;
}

function approvalCommand(approval: BoundApproval): RuntimeCommand | undefined {
  if (approval.command && approval.action && approval.command !== approval.action) {
    return undefined;
  }
  return approval.command ?? approval.action;
}

/** Normalize a configured origin, rejecting wildcards, credentials, paths, queries, and fragments. */
export function normalizeExactOrigin(input: string): string | undefined {
  if (input.includes("*") || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+\/?$/u.test(input)) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return undefined;
  }

  if (
    !ORIGIN_PROTOCOLS.has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }

  return parsed.origin;
}

function escapeRegexCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function compileRoutePattern(pattern: string): RegExp | undefined {
  if (
    !pattern.startsWith("/") ||
    pattern.length > MAX_ROUTE_PATTERN_LENGTH ||
    pattern.includes("\\") ||
    pattern.includes("?") ||
    pattern.includes("#") ||
    pattern.includes("://") ||
    /%(?:00|2f|5c)/iu.test(pattern)
  ) {
    return undefined;
  }

  const segments = pattern.split("/").slice(1);
  if (
    pattern !== "/" &&
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  const compiled: string[] = [];

  for (const [index, segment] of segments.entries()) {
    if (segment === "**") {
      if (index !== segments.length - 1) {
        return undefined;
      }
      compiled.push("(?:.*)");
      continue;
    }

    if (segment === "*" || /^:[A-Za-z][A-Za-z0-9_]*$/u.test(segment)) {
      compiled.push("[^/]+");
      continue;
    }

    if (/^\{[A-Za-z][A-Za-z0-9_]*\}$/u.test(segment)) {
      compiled.push("[^/]+");
      continue;
    }

    if (segment.includes("*") || segment.includes("{") || segment.includes("}")) {
      return undefined;
    }

    compiled.push([...segment].map(escapeRegexCharacter).join(""));
  }

  return new RegExp(`^/${compiled.join("/")}$`, "u");
}

/** Match only a URL pathname. Search parameters and fragments never participate in policy. */
export function routeMatches(pattern: string, route: string): boolean {
  const compiled = compileRoutePattern(pattern);
  if (
    !compiled ||
    !route.startsWith("/") ||
    route.includes("\\") ||
    /%(?:00|2f|5c)/iu.test(route)
  ) {
    return false;
  }
  return compiled.test(route);
}

function toTimestamp(value: string | number | Date): number | undefined {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function invalidLayer(layer: PolicyLayer): string | undefined {
  if (!layer.name.trim()) {
    return "policy layer has no name";
  }

  if (layer.allowedOrigins?.some((origin) => normalizeExactOrigin(origin) === undefined)) {
    return "policy layer contains a non-exact origin";
  }

  if (layer.allowedRoutes?.some((route) => compileRoutePattern(route) === undefined)) {
    return "policy layer contains an invalid route pattern";
  }

  const enumerations = [
    layer.allowedCommands,
    layer.allowedActions,
    layer.allowedEffects,
    layer.approvalRequiredFor,
  ];
  if (enumerations.some((values) => values?.some((value) => !value.trim()))) {
    return "policy layer contains an empty action or effect";
  }

  if (
    layer.allowedCommands?.some((command) => !RUNTIME_COMMANDS.has(command)) ||
    layer.allowedActions?.some((command) => !RUNTIME_COMMANDS.has(command)) ||
    layer.allowedEffects?.some((effect) => !EFFECT_CLASSES.has(effect)) ||
    layer.approvalRequiredFor?.some((effect) => !EFFECT_CLASSES.has(effect))
  ) {
    return "policy layer contains an unknown command or effect";
  }

  return undefined;
}

function approvalMatches(
  approval: BoundApproval,
  request: PolicyRequest,
  origin: string,
  route: string,
  command: RuntimeCommand,
  now: number,
): boolean {
  const expiry = toTimestamp(approval.expiresAt);
  return (
    approval.id.trim().length > 0 &&
    approval.runId === request.runId &&
    approvalCommand(approval) === command &&
    approval.effect === request.effect &&
    normalizeExactOrigin(approval.origin) === origin &&
    approval.route === route &&
    expiry !== undefined &&
    expiry > now &&
    (request.capabilityDigest === undefined ||
      approval.capabilityDigest === request.capabilityDigest)
  );
}

function humanGrantMatches(grant: HumanControlGrant, request: PolicyRequest, now: number): boolean {
  const expiry = toTimestamp(grant.expiresAt);
  return (
    request.actor === "operator" &&
    grant.id.trim().length > 0 &&
    grant.runId === request.runId &&
    grant.sessionId === request.sessionId &&
    grant.ownerEpoch === request.ownerEpoch &&
    Number.isSafeInteger(grant.ownerEpoch) &&
    grant.ownerEpoch >= 0 &&
    expiry !== undefined &&
    expiry > now
  );
}

/**
 * Evaluate a request against every supplied layer.
 *
 * An omitted dimension means that layer does not constrain the dimension. An
 * explicitly empty allowlist denies every value in that dimension.
 */
export function checkPolicy(
  policy: PolicyStack | readonly PolicyLayer[],
  request: PolicyRequest,
): PolicyDecision {
  const layers = layersOf(policy);
  if (layers.length === 0) {
    return {
      allowed: false,
      code: "POLICY_INVALID",
      summary: "No policy layers were supplied.",
    };
  }

  const parsedUrl = parseRequestUrl(request.url);
  if (!parsedUrl) {
    return {
      allowed: false,
      code: "POLICY_INVALID",
      summary: "The request URL is not an eligible HTTP(S) URL.",
    };
  }

  const command = requestCommand(request);
  if (!command || !request.effect.trim() || !request.runId.trim()) {
    return {
      allowed: false,
      code: "POLICY_INVALID",
      summary: "The policy request is missing a run, command, or effect.",
    };
  }

  if (!RUNTIME_COMMANDS.has(command) || !EFFECT_CLASSES.has(request.effect)) {
    return {
      allowed: false,
      code: !RUNTIME_COMMANDS.has(command) ? "ACTION_DENIED" : "EFFECT_DENIED",
      summary: "The request contains an unknown command or effect class.",
    };
  }

  const matchedRoutes: Record<string, string> = {};
  let approvalRequired = request.effect === "commit";

  for (const layer of layers) {
    const invalidReason = invalidLayer(layer);
    if (invalidReason) {
      return {
        allowed: false,
        code: "POLICY_INVALID",
        summary: invalidReason,
        layer: layer.name || "unnamed",
      };
    }

    if (
      layer.allowedOrigins &&
      !layer.allowedOrigins.some(
        (allowedOrigin) => normalizeExactOrigin(allowedOrigin) === parsedUrl.origin,
      )
    ) {
      return {
        allowed: false,
        code: "ORIGIN_DENIED",
        summary: "The exact origin is not allowed by policy.",
        layer: layer.name,
      };
    }

    if (layer.allowedRoutes) {
      const matchedRoute = layer.allowedRoutes.find((pattern) =>
        routeMatches(pattern, parsedUrl.pathname),
      );
      if (!matchedRoute) {
        return {
          allowed: false,
          code: "ROUTE_DENIED",
          summary: "The current route is not allowed by policy.",
          layer: layer.name,
        };
      }
      matchedRoutes[layer.name] = matchedRoute;
    }

    if (layer.allowedCommands && !layer.allowedCommands.includes(command)) {
      return {
        allowed: false,
        code: "ACTION_DENIED",
        summary: "The command type is not allowed by policy.",
        layer: layer.name,
      };
    }

    if (layer.allowedActions && !layer.allowedActions.includes(command)) {
      return {
        allowed: false,
        code: "ACTION_DENIED",
        summary: "The command type is not allowed by policy.",
        layer: layer.name,
      };
    }

    if (layer.allowedEffects && !layer.allowedEffects.includes(request.effect)) {
      return {
        allowed: false,
        code: "EFFECT_DENIED",
        summary: "The effect class is not allowed by policy.",
        layer: layer.name,
      };
    }

    approvalRequired ||= layer.approvalRequiredFor?.includes(request.effect) ?? false;
  }

  let authorization: PolicyGrant["authorization"] = "policy";
  if (approvalRequired) {
    const now = toTimestamp(request.now ?? Date.now());
    if (now === undefined) {
      return {
        allowed: false,
        code: "POLICY_INVALID",
        summary: "The policy evaluation time is invalid.",
      };
    }

    if (request.approval) {
      if (
        !approvalMatches(
          request.approval,
          request,
          parsedUrl.origin,
          parsedUrl.pathname,
          command,
          now,
        )
      ) {
        return {
          allowed: false,
          code: "APPROVAL_INVALID",
          summary: "The approval is expired or is not bound to this exact request.",
        };
      }
      authorization = "bound_approval";
    } else if (request.humanGrant) {
      if (!humanGrantMatches(request.humanGrant, request, now)) {
        return {
          allowed: false,
          code: "APPROVAL_INVALID",
          summary: "The human control grant is expired or is not bound to this session epoch.",
        };
      }
      authorization = "human_control";
    } else {
      return {
        allowed: false,
        code: "APPROVAL_REQUIRED",
        summary: "This effect requires a bound approval or active human control grant.",
      };
    }
  }

  return {
    allowed: true,
    origin: parsedUrl.origin,
    route: parsedUrl.pathname,
    command,
    action: command,
    effect: request.effect,
    authorization,
    matchedRoutes,
  };
}

/** Adapt the canonical artifact schema into an independently enforced policy layer. */
export function capabilityPolicyLayer(
  requirements: CapabilityPolicyRequirements,
  name = "capability",
): PolicyLayer {
  return {
    name,
    allowedRoutes: requirements.allowedRoutes,
    allowedCommands: requirements.allowedCommands,
    allowedEffects: requirements.allowedEffects,
    approvalRequiredFor: requirements.approvalRequiredFor,
  };
}

/** Adapt a tenant binding's exact allowlists without widening any dimension. */
export function bindingPolicyLayer(binding: AppBinding, name = "binding"): PolicyLayer {
  return {
    name,
    allowedOrigins: binding.policy.allowedOrigins,
    allowedRoutes: binding.policy.allowedRoutes,
    allowedCommands: binding.policy.allowedCommands,
    allowedEffects: binding.policy.allowedEffects,
  };
}

export class PolicyDeniedError extends Error {
  readonly decision: PolicyDenial;

  constructor(decision: PolicyDenial) {
    super(`${decision.code}: ${decision.summary}`);
    this.name = "PolicyDeniedError";
    this.decision = decision;
  }
}

/** Return a grant or throw a typed, sanitized denial. */
export function enforcePolicy(
  policy: PolicyStack | readonly PolicyLayer[],
  request: PolicyRequest,
): PolicyGrant {
  const decision = checkPolicy(policy, request);
  if (!decision.allowed) {
    throw new PolicyDeniedError(decision);
  }
  return decision;
}
