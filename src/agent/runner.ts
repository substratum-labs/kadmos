import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { TransitionStepRequest } from "../types/ports.js";
import type { WorldSpec } from "../types/world.js";
import { createWorldChecker } from "../world_checker.js";
import { compileWorldSpec, parseWorldSpec } from "../world_compiler.js";
import { synthesizeCegisPrompt } from "./cegis_prompt.js";
import type { ChatMessage, ILlmProvider } from "./provider.js";

export interface AgentRunOptions {
  readonly prdPath: string;
  readonly worldSpecPath: string;
  readonly outDir: string;
  readonly provider: ILlmProvider;
  readonly maxRepairTurns?: number;
}

export interface AgentRunResult {
  readonly success: boolean;
  readonly turnsExecuted: number;
  readonly totalTokensUsed: number;
  readonly totalCostUsd?: number;
  readonly generatedCodePath?: string;
  readonly finalVerdict: "CONSTITUTIONAL_ACCEPTED" | "MAX_TURNS_EXCEEDED" | "COMPILATION_FAILED";
  readonly executionTrace: readonly string[];
}

export function buildInitialPrompt(prdContent: string, worldSpec: WorldSpec, portsDts: string): string {
  return [
    "You are the Kadmos Fabric Builder. Generate a single self-contained TypeScript service class for this PRD.",
    "CONSTITUTIONAL RULES:",
    "1. Follow the generated ports.d.ts membrane.",
    "2. Before any physical side effect, call checker.step() with the transitionId and proposedDirective.",
    "3. If verdict.allowed is false, abort without performing the side effect.",
    "4. Never bypass or falsify checker state. Drive all transitions through checker.step().",
    "",
    "PRD:", prdContent,
    "", "WORLD SPEC:", JSON.stringify(worldSpec, null, 2),
    "", "INVARIANTS:", ...worldSpec.invariants.map((rule) => `- ${rule.id}: ${rule.predicate}`),
    "", "PORTS.D.TS:", portsDts,
    "", "Return exactly one ```json block containing {\"steps\":[{\"transitionId\":\"...\",\"proposedDirective\":\"...\",\"eventPayload\":{}}]} and one ```typescript block containing the complete service code. The steps must describe the complete legal journey to a terminal state. The runner checks the plan before writing code.",
  ].join("\n");
}

function fenced(content: string, language: string): string | undefined {
  return new RegExp(`\\x60\\x60\\x60${language}\\s*\\n([\\s\\S]*?)\\n\\x60\\x60\\x60`, "i").exec(content)?.[1];
}

function parseCandidate(content: string): { code: string; steps: TransitionStepRequest[] } {
  const code = fenced(content, "typescript") ?? fenced(content, "ts");
  const plan = fenced(content, "json");
  if (!code?.trim() || !plan) throw new Error("Candidate requires TypeScript and JSON plan blocks");
  const parsed: unknown = JSON.parse(plan);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { steps?: unknown }).steps)) throw new Error("Candidate plan requires steps array");
  const steps = (parsed as { steps: unknown[] }).steps;
  if (steps.length === 0 || steps.some((step) => !step || typeof step !== "object" || typeof (step as { transitionId?: unknown }).transitionId !== "string")) throw new Error("Candidate plan has invalid steps");
  return { code, steps: steps as TransitionStepRequest[] };
}

function compileCandidate(code: string, portsDts: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "kadmos-typecheck-"));
  try {
    const codePath = join(directory, "fabric.ts");
    writeFileSync(codePath, code);
    writeFileSync(join(directory, "ports.d.ts"), portsDts);
    const require = createRequire(import.meta.url);
    const tscPath = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
    const check = spawnSync(process.execPath, [tscPath, "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "ES2022", codePath], { encoding: "utf8" });
    return check.status === 0 ? [] : [(check.stdout + check.stderr).trim() || "TypeScript compiler failed"];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function runKadmosAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const maxTurns = options.maxRepairTurns ?? 3;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error("maxRepairTurns must be a positive integer");
  const prdContent = readFileSync(options.prdPath, "utf8");
  const worldSpec = parseWorldSpec(readFileSync(options.worldSpecPath, "utf8"));
  const { portsDts } = compileWorldSpec(worldSpec);
  const initialPrompt = buildInitialPrompt(prdContent, worldSpec, portsDts);
  const messages: ChatMessage[] = [{ role: "user", content: initialPrompt }];
  const executionTrace: string[] = [];
  let totalTokensUsed = 0;
  let totalCostUsd = 0;
  let hasCost = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const reply = await options.provider.complete({ systemPrompt: "You are the Kadmos Fabric Builder. Obey the World constitution and output only the requested blocks.", messages });
    totalTokensUsed += reply.usage?.totalTokens ?? 0;
    if (reply.usage?.estimatedCostUsd !== undefined) { totalCostUsd += reply.usage.estimatedCostUsd; hasCost = true; }
    messages.push({ role: "assistant", content: reply.content });
    let candidate: { code: string; steps: TransitionStepRequest[] };
    try {
      candidate = parseCandidate(reply.content);
      const diagnostics = compileCandidate(candidate.code, portsDts);
      if (diagnostics.length) throw new Error(diagnostics.join("; "));
    } catch (error) {
      executionTrace.push(`Turn ${turn}: compilation failed: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, turnsExecuted: turn, totalTokensUsed, ...(hasCost ? { totalCostUsd } : {}), finalVerdict: "COMPILATION_FAILED", executionTrace };
    }

    const checker = createWorldChecker(worldSpec);
    let refused = false;
    for (const step of candidate.steps) {
      const verdict = checker.step(step);
      executionTrace.push(`Turn ${turn}: ${step.transitionId}: ${verdict.allowed ? "ACCEPTED" : `DENIED ${verdict.violation?.code ?? "UNKNOWN"}`}`);
      if (!verdict.allowed) {
        messages.push({ role: "user", content: synthesizeCegisPrompt(verdict, worldSpec) });
        refused = true;
        break;
      }
    }
    if (refused) continue;
    if (!worldSpec.states.some((state) => state.id === checker.getState() && state.terminal)) {
      executionTrace.push(`Turn ${turn}: non-terminal state ${checker.getState()}`);
      return { success: false, turnsExecuted: turn, totalTokensUsed, ...(hasCost ? { totalCostUsd } : {}), finalVerdict: "COMPILATION_FAILED", executionTrace };
    }
    mkdirSync(options.outDir, { recursive: true });
    const generatedCodePath = join(options.outDir, "fabric.ts");
    writeFileSync(generatedCodePath, candidate.code);
    return { success: true, turnsExecuted: turn, totalTokensUsed, ...(hasCost ? { totalCostUsd } : {}), generatedCodePath, finalVerdict: "CONSTITUTIONAL_ACCEPTED", executionTrace };
  }
  return { success: false, turnsExecuted: maxTurns, totalTokensUsed, ...(hasCost ? { totalCostUsd } : {}), finalVerdict: "MAX_TURNS_EXCEEDED", executionTrace };
}
