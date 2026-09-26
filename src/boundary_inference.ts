import { compileWorldSpec, parseWorldSpec } from "./world_compiler.js";
import type { ILlmProvider } from "./agent/provider.js";
import type { WorldSpec } from "./types/world.js";

export type BoundaryCategory = "monetary" | "lifecycle" | "safety" | "side_effect" | "network" | "timeout" | "retry" | "cache" | "formatting" | "ui";
export interface BoundaryCandidate {
  readonly category: BoundaryCategory;
  readonly evidence: string;
  readonly justification: string;
}
export interface BoundaryInferenceResult {
  readonly source: "heuristic" | "hybrid";
  readonly inputContent: string;
  readonly worldCandidates: readonly BoundaryCandidate[];
  readonly fabricCandidates: readonly BoundaryCandidate[];
  readonly worldSpec: WorldSpec;
  readonly worldYaml: string;
  readonly portsDts: string;
}
export interface BoundaryInferenceOptions {
  readonly name?: string;
  readonly provider?: ILlmProvider;
  readonly model?: string;
}
export interface SemanticWorldExtraction {
  readonly states: readonly { readonly id: string; readonly initial?: boolean; readonly terminal?: boolean }[];
  readonly context: Readonly<Record<string, { readonly type: "integer"; readonly unit?: string; readonly min?: number; readonly max?: number; readonly default?: number }>>;
  readonly invariants: readonly { readonly id: string; readonly description?: string; readonly predicate: string }[];
  readonly transitions: readonly { readonly id: string; readonly from: string; readonly to: string; readonly guard: string; readonly directive?: string | null; readonly effects?: readonly string[] }[];
}

const rules: readonly { category: BoundaryCategory; domain: "world" | "fabric"; pattern: RegExp; justification: string }[] = [
  { category: "monetary", domain: "world", pattern: /\b(?:escrow[ _-]?balance|refund(?:ed)?[ _-]?(?:amount)?|balance|amount|transfer|fee|quota|payment|money|cents?)\b|\+=|-=|\brefund\b/i, justification: "A bounded quantity or conservation rule may need World context." },
  { category: "lifecycle", domain: "world", pattern: /\b(?:status|stage|phase|is_completed|CREATED|PENDING|PAID|CANCELLED|FULFILLED)\b/i, justification: "A lifecycle may need closed states and guarded transitions." },
  { category: "safety", domain: "world", pattern: /\b(?:assert|require|guard|has_role|must never|cannot|nonnegative|non-negative|>=\s*0|idempoten\w*)\b/i, justification: "A safety condition may need an invariant or transition guard." },
  { category: "side_effect", domain: "world", pattern: /(?:\bfetch\s*\(|\baxios\b|\bsqs\.send\s*\(|\bpayment\.charge\s*\(|\bsms\b|\bwriteFile\s*\(|\bwebhook\b|\bgateway\b|disk I\/O)/i, justification: "An external effect needs a candidate directive at the World/Fabric seam." },
  { category: "network", domain: "fabric", pattern: /\b(?:fetch\s*\(|axios\b|https?\b|network\b|rpc\b|headers?\b|webhook\b|sqs\.send\s*\()/i, justification: "Transport and request mechanics belong in Fabric." },
  { category: "timeout", domain: "fabric", pattern: /\b(?:timeout|setTimeout|deadline|in.flight|in-flight)\b/i, justification: "Timeout handling is a physical execution policy." },
  { category: "retry", domain: "fabric", pattern: /\b(?:retry|retries|backoff|replay)\b/i, justification: "Retry scheduling belongs in Fabric unless legislation elevates its safety boundary." },
  { category: "cache", domain: "fabric", pattern: /\b(?:cache|redis|memoiz\w*)\b/i, justification: "Caching is Fabric execution policy." },
  { category: "formatting", domain: "fabric", pattern: /\b(?:format(?:ting)?|locale|localized|JSON\.parse|date format)\b/i, justification: "Presentation and parsing belong in Fabric." },
  { category: "ui", domain: "fabric", pattern: /\b(?:UI|CSS|React|Vue|component|animation)\b/i, justification: "Interface rendering belongs in Fabric." },
];

function yamlScalar(value: string | number | boolean | null): string {
  return value === null ? "null" : typeof value === "string" ? JSON.stringify(value) : String(value);
}

export function serializeWorldSpec(spec: WorldSpec): string {
  const lines = [`version: ${yamlScalar(spec.version)}`, `name: ${yamlScalar(spec.name)}`];
  if (spec.description !== undefined) lines.push(`description: ${yamlScalar(spec.description)}`);
  lines.push("states:");
  for (const state of spec.states) {
    lines.push(`  - id: ${yamlScalar(state.id)}`);
    if (state.initial) lines.push("    initial: true");
    if (state.terminal) lines.push("    terminal: true");
    if (state.description !== undefined) lines.push(`    description: ${yamlScalar(state.description)}`);
  }
  lines.push("context:");
  for (const [name, value] of Object.entries(spec.context)) {
    lines.push(`  ${name}:`, "    type: integer");
    if (value.unit) lines.push(`    unit: ${yamlScalar(value.unit)}`);
    if (value.min !== undefined) lines.push(`    min: ${value.min}`);
    if (value.max !== undefined) lines.push(`    max: ${value.max}`);
    if (value.default !== undefined) lines.push(`    default: ${value.default}`);
  }
  if (!Object.keys(spec.context).length) lines[lines.length - 1] = "context: {}";
  lines.push(spec.invariants.length ? "invariants:" : "invariants: []");
  for (const invariant of spec.invariants) {
    lines.push(`  - id: ${yamlScalar(invariant.id)}`);
    if (invariant.description !== undefined) lines.push(`    description: ${yamlScalar(invariant.description)}`);
    lines.push(`    predicate: ${yamlScalar(invariant.predicate)}`);
  }
  lines.push(spec.transitions.length ? "transitions:" : "transitions: []");
  for (const transition of spec.transitions) {
    lines.push(`  - id: ${yamlScalar(transition.id)}`, `    from: ${yamlScalar(transition.from)}`, `    to: ${yamlScalar(transition.to)}`, `    guard: ${yamlScalar(transition.guard)}`, `    directive: ${yamlScalar(transition.directive)}`);
    lines.push(transition.effects.length ? "    effects:" : "    effects: []");
    for (const effect of transition.effects) lines.push(`      - ${yamlScalar(effect)}`);
  }
  return `${lines.join("\n")}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseExtraction(content: string): SemanticWorldExtraction {
  const raw: unknown = JSON.parse(content);
  if (!isRecord(raw) || !Array.isArray(raw.states) || !isRecord(raw.context) || !Array.isArray(raw.invariants) || !Array.isArray(raw.transitions)) throw new Error("INVALID_EXTRACTION: collections");
  for (const state of raw.states) {
    if (!isRecord(state) || typeof state.id !== "string" || !validId(state.id) || state.initial !== undefined && typeof state.initial !== "boolean" || state.terminal !== undefined && typeof state.terminal !== "boolean") throw new Error("INVALID_EXTRACTION: state");
  }
  for (const [name, value] of Object.entries(raw.context)) {
    if (!validId(name) || !isRecord(value) || value.type !== "integer" || value.unit !== undefined && typeof value.unit !== "string" || [value.min, value.max, value.default].some((number) => number !== undefined && (typeof number !== "number" || !Number.isSafeInteger(number)))) throw new Error("INVALID_EXTRACTION: context");
  }
  for (const invariant of raw.invariants) {
    if (!isRecord(invariant) || typeof invariant.id !== "string" || !validId(invariant.id) || typeof invariant.predicate !== "string" || invariant.description !== undefined && typeof invariant.description !== "string") throw new Error("INVALID_EXTRACTION: invariant");
  }
  for (const transition of raw.transitions) {
    if (!isRecord(transition) || typeof transition.id !== "string" || !validId(transition.id) || typeof transition.from !== "string" || !validId(transition.from) || typeof transition.to !== "string" || !validId(transition.to) || typeof transition.guard !== "string" || transition.directive !== undefined && transition.directive !== null && typeof transition.directive !== "string" || transition.effects !== undefined && (!Array.isArray(transition.effects) || !transition.effects.every((effect: unknown) => typeof effect === "string"))) throw new Error("INVALID_EXTRACTION: transition");
  }
  return raw as unknown as SemanticWorldExtraction;
}

function validId(value: string): boolean { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value); }

const RESERVED_LEGISLATIVE_STATES = new Set(["ARBITRATION", "OUTCOME_UNKNOWN", "REFUNDED", "SETTLED"]);

function mergeWorldSpec(local: WorldSpec, extracted: SemanticWorldExtraction): WorldSpec {
  if (extracted.states.some((state) => RESERVED_LEGISLATIVE_STATES.has(state.id))
    || extracted.transitions.some((transition) => RESERVED_LEGISLATIVE_STATES.has(transition.from) || RESERVED_LEGISLATIVE_STATES.has(transition.to)
      || [...RESERVED_LEGISLATIVE_STATES].some((state) => transition.id.includes(state)))) throw new Error("RESERVED_LEGISLATIVE_STATE");
  const chosenInitial = local.states.find((state) => state.initial)!.id;
  if (extracted.states.some((state) => state.initial && state.id !== chosenInitial)) throw new Error(`CONFLICTING_INITIAL_STATE: ${chosenInitial}`);
  const states = new Map(local.states.map((state) => [state.id, state]));
  for (const state of extracted.states) states.set(state.id, { ...states.get(state.id), ...state });
  if (!states.has(chosenInitial)) states.set(chosenInitial, { id: chosenInitial });
  const context = { ...local.context };
  for (const [name, field] of Object.entries(extracted.context)) {
    const existing = context[name];
    if (field.max !== undefined && field.max < 1
      || existing && field.max !== undefined && field.max !== existing.max
      || field.default !== undefined && field.default !== 0
      || existing && (existing.min !== undefined && (field.min === undefined || field.min < existing.min)
      || existing.max !== undefined && (field.max === undefined || field.max > existing.max)
      || existing.unit !== undefined && field.unit !== undefined && existing.unit !== field.unit
      || field.default !== undefined && field.default !== existing.default
      || field.default !== undefined && (existing.min !== undefined && field.default < existing.min || existing.max !== undefined && field.default > existing.max))) throw new Error(`CONFLICTING_BOUNDS: ${name}`);
    context[name] = { ...existing, ...field };
  }
  const invariants = [...local.invariants];
  for (const item of extracted.invariants) {
    const existing = invariants.find((other) => other.id === item.id);
    if (existing && existing.predicate !== item.predicate) throw new Error(`CONFLICTING_INVARIANT: ${item.id}`);
    if (!existing && !invariants.some((other) => other.predicate === item.predicate)) invariants.push(item);
  }
  const transitions = [...local.transitions];
  const allowedDirectives = new Set(local.transitions.map((transition) => transition.directive).filter((directive) => directive !== null));
  for (const item of extracted.transitions) {
    const candidate = { ...item, directive: item.directive ?? null, effects: item.effects ?? [] };
    if (candidate.directive !== null && !allowedDirectives.has(candidate.directive)) throw new Error(`UNDECLARED_DIRECTIVE: ${candidate.directive}`);
    for (const effect of candidate.effects) {
      const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(effect);
      if (!assignment || Object.hasOwn(local.context, assignment[1]!)
        || /^(?:escrow_balance|order_amount|refunded_amount|settled_amount)$/.test(assignment[1]!)
        || !Object.hasOwn(extracted.context, assignment[1]!)
        || !Object.hasOwn(context, assignment[2]!)) throw new Error(`CONFLICTING_TRANSITION: ${item.id}`);
    }
    const existing = transitions.find((other) => other.id === item.id || other.from === item.from && other.to === item.to);
    if (existing) {
      if (existing.id !== candidate.id || existing.from !== candidate.from || existing.to !== candidate.to || existing.guard !== candidate.guard || existing.directive !== candidate.directive || JSON.stringify(existing.effects) !== JSON.stringify(candidate.effects)) throw new Error(`CONFLICTING_TRANSITION: ${item.id}`);
    } else transitions.push(candidate);
  }
  return {
    ...local,
    states: [...states.values()].map((state) => ({ ...state, initial: state.id === chosenInitial })),
    context,
    invariants,
    transitions,
  };
}

function resultFor(inputContent: string, worldCandidates: BoundaryCandidate[], fabricCandidates: BoundaryCandidate[], worldSpec: WorldSpec, source: "heuristic" | "hybrid" = "heuristic"): BoundaryInferenceResult {
  const worldYaml = serializeWorldSpec(worldSpec);
  const validated = parseWorldSpec(worldYaml);
  return { source, inputContent, worldCandidates, fabricCandidates, worldSpec: validated, worldYaml, portsDts: compileWorldSpec(validated).portsDts };
}

export function inferBoundary(inputContent: string, options?: BoundaryInferenceOptions & { provider?: undefined }): BoundaryInferenceResult;
export function inferBoundary(inputContent: string, options: BoundaryInferenceOptions & { provider: ILlmProvider }): Promise<BoundaryInferenceResult>;
export function inferBoundary(inputContent: string, options: BoundaryInferenceOptions = {}): BoundaryInferenceResult | Promise<BoundaryInferenceResult> {
  const worldCandidates: BoundaryCandidate[] = [];
  const fabricCandidates: BoundaryCandidate[] = [];
  for (const rule of rules) {
    const match = rule.pattern.exec(inputContent);
    if (!match) continue;
    (rule.domain === "world" ? worldCandidates : fabricCandidates).push({ category: rule.category, evidence: match[0], justification: rule.justification });
  }
  const amounts = new Set<string>();
  for (const [pattern, name] of [
    [/\bescrow[ _-]?balance\b/i, "escrow_balance"], [/\brefund(?:ed)?[ _-]?amount\b/i, "refunded_amount"],
    [/\bbalance\b/i, "balance"], [/\b(?:order[ _-]?)?amount\b/i, "amount"], [/\bquota\b/i, "quota"], [/\bfee\b/i, "fee"],
  ] as const) if (pattern.test(inputContent)) amounts.add(name);
  if (amounts.has("escrow_balance")) amounts.delete("balance");
  const context = Object.fromEntries([...amounts].map((name) => [name, { type: "integer" as const, ...(/amount|balance|fee/.test(name) ? { unit: "cents" } : {}), min: 0, max: 1_000_000_000, default: 0 }]));
  const foundStates = [...new Set((inputContent.match(/\b(?:CREATED|PAYMENT_PENDING|PENDING|PAID|CANCELLING|CANCELLED|FULFILLED|COMPLETED|FAILED|ACTIVE|DRAFT)\b/g) ?? []))];
  const initial = foundStates.includes("CREATED") ? "CREATED" : foundStates.includes("DRAFT") ? "DRAFT" : "INITIAL";
  const states = [initial, ...foundStates.filter((state) => state !== initial)].map((id, index) => ({ id, ...(index === 0 ? { initial: true } : {}) }));
  const directives: string[] = [];
  if (/payment\.charge\s*\(|\bpayment (?:capture|gateway)\b/i.test(inputContent)) directives.push("DISPATCH_PAYMENT");
  if (/\bfetch\s*\(|\baxios\b/i.test(inputContent)) directives.push("DISPATCH_HTTP_REQUEST");
  if (/\bsqs\.send\s*\(/i.test(inputContent)) directives.push("DISPATCH_QUEUE_MESSAGE");
  if (/\bsms\b/i.test(inputContent)) directives.push("DISPATCH_SMS");
  if (/\bwriteFile\s*\(|disk I\/O/i.test(inputContent)) directives.push("DISPATCH_DISK_WRITE");
  const statePattern = "(?:CREATED|PAYMENT_PENDING|PENDING|PAID|CANCELLING|CANCELLED|FULFILLED|COMPLETED|FAILED|ACTIVE|DRAFT)";
  const explicitMoves = [...inputContent.matchAll(new RegExp(`(?=\\b(${statePattern})\\s+(?:->|to)\\s+(${statePattern})\\b)`, "g"))]
    .map((match) => [match[1]!, match[2]!] as const);
  const name = (options.name ?? "InferredWorld").replace(/[^A-Za-z0-9_]/g, "_") || "InferredWorld";
  const worldSpec: WorldSpec = {
    version: "kadmos.world.v0", name, description: "Candidate draft; review before adoption", states, context,
    invariants: /must never be negative|nonnegative|non-negative|>=\s*0/i.test(inputContent)
      ? [...amounts].map((field, index) => ({ id: `INV_${index + 1}_NONNEGATIVE`, description: `${field} cannot be negative`, predicate: `${field} >= 0` })) : [],
    transitions: [
      ...explicitMoves.map(([from, to]) => ({ id: `MOVE_${from}_TO_${to}`, from, to, guard: true, directive: null, effects: [] })),
      ...directives.map((directive) => ({ id: directive, from: initial, to: initial, guard: true, directive, effects: [] })),
    ],
  };
  const baseline = resultFor(inputContent, worldCandidates, fabricCandidates, worldSpec);
  if (!options.provider) return baseline;
  return (async () => {
    try {
      const response = await options.provider!.complete({
        systemPrompt: "You are a formal methods software architect extracting formal World IR specifications from requirements. Return a single valid JSON object strictly adhering to SemanticWorldExtraction schema.",
        messages: [{ role: "user", content: `Extract a SemanticWorldExtraction JSON object with states [{id, initial?, terminal?}], context {field: {type: "integer", min?, max?, default?}}, invariants [{id, description?, predicate}], and transitions [{id, from, to, guard, directive?, effects?}]. Use only declared context fields in expressions. Requirements:\n${inputContent}` }],
        responseFormat: "json_object",
        temperature: 0.1,
        ...(options.model ? { model: options.model } : {}),
      });
      return resultFor(inputContent, worldCandidates, fabricCandidates, mergeWorldSpec(worldSpec, parseExtraction(response.content)), "hybrid");
    } catch {
      return baseline;
    }
  })();
}
