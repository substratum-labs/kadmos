import { compileWorldSpec } from "./world_compiler.js";
import type { WorldSpec } from "./types/world.js";

export type BoundaryCategory = "monetary" | "lifecycle" | "safety" | "side_effect" | "network" | "timeout" | "retry" | "cache" | "formatting" | "ui";
export interface BoundaryCandidate {
  readonly category: BoundaryCategory;
  readonly evidence: string;
  readonly justification: string;
}
export interface BoundaryInferenceResult {
  readonly inputContent: string;
  readonly worldCandidates: readonly BoundaryCandidate[];
  readonly fabricCandidates: readonly BoundaryCandidate[];
  readonly worldSpec: WorldSpec;
  readonly worldYaml: string;
  readonly portsDts: string;
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

function toYaml(spec: WorldSpec): string {
  const lines = [`version: ${yamlScalar(spec.version)}`, `name: ${yamlScalar(spec.name)}`, `description: ${yamlScalar(spec.description ?? "Candidate draft; review before adoption")}`, "states:"];
  for (const state of spec.states) {
    lines.push(`  - id: ${yamlScalar(state.id)}`);
    if (state.initial) lines.push("    initial: true");
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
  for (const invariant of spec.invariants) lines.push(`  - id: ${yamlScalar(invariant.id)}`, `    description: ${yamlScalar(invariant.description ?? "Candidate invariant")}`, `    predicate: ${yamlScalar(invariant.predicate)}`);
  lines.push(spec.transitions.length ? "transitions:" : "transitions: []");
  for (const transition of spec.transitions) lines.push(`  - id: ${yamlScalar(transition.id)}`, `    from: ${yamlScalar(transition.from)}`, `    to: ${yamlScalar(transition.to)}`, `    guard: ${yamlScalar(transition.guard)}`, `    directive: ${yamlScalar(transition.directive)}`, "    effects: []");
  return `${lines.join("\n")}\n`;
}

export function inferBoundary(inputContent: string, options: { name?: string } = {}): BoundaryInferenceResult {
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
      ? [...amounts].map((field, index) => ({ id: `INV-${index + 1}-NONNEGATIVE`, description: `${field} cannot be negative`, predicate: `${field} >= 0` })) : [],
    transitions: [
      ...explicitMoves.map(([from, to]) => ({ id: `MOVE_${from}_TO_${to}`, from, to, guard: true, directive: null, effects: [] })),
      ...directives.map((directive) => ({ id: directive, from: initial, to: initial, guard: true, directive, effects: [] })),
    ],
  };
  return { inputContent, worldCandidates, fabricCandidates, worldSpec, worldYaml: toYaml(worldSpec), portsDts: compileWorldSpec(worldSpec).portsDts };
}
