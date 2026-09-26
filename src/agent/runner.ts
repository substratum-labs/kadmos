import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { TransitionStepRequest } from "../types/ports.js";
import type { WorldSpec } from "../types/world.js";
import { createWorldChecker } from "../world_checker.js";
import { compileWorldSpec, parseWorldSpec } from "../world_compiler.js";
import { synthesizeCegisPrompt } from "./cegis_prompt.js";
import type { ChatMessage, ILlmProvider, LlmCompletionResponse } from "./provider.js";

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
  readonly finalVerdict: "CONSTITUTIONAL_ACCEPTED" | "MAX_TURNS_EXCEEDED" | "COMPILATION_FAILED" | "MALFORMED_OUTPUT";
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
    "", "Return exactly one ```json block containing {\"steps\":[{\"transitionId\":\"...\",\"proposedDirective\":\"...\",\"eventPayload\":{}}]} and one ```typescript block containing the complete service code. Export a service class with a run() method containing direct checker.step({...}) calls with literal request objects matching the JSON steps in order. The steps must describe the complete legal journey to a terminal state.",
  ].join("\n");
}

function fenced(content: string, language: string): string | undefined {
  return new RegExp(`\\x60\\x60\\x60${language}\\s*\\n([\\s\\S]*?)\\n\\x60\\x60\\x60`, "i").exec(content)?.[1];
}

function parseCandidate(content: string): { code: string; steps: TransitionStepRequest[] } {
  const code = fenced(content, "typescript") ?? fenced(content, "ts");
  const plan = fenced(content, "json");
  if (!code?.trim() || !plan) throw new Error("Candidate requires TypeScript and JSON plan blocks");
  let parsed: unknown;
  try { parsed = JSON.parse(plan); } catch { throw new Error("Candidate JSON plan is malformed"); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { steps?: unknown }).steps)) throw new Error("Candidate plan requires steps array");
  const steps = (parsed as { steps: unknown[] }).steps;
  if (steps.length === 0 || steps.some((step) => !step || typeof step !== "object" || typeof (step as { transitionId?: unknown }).transitionId !== "string")) throw new Error("Candidate plan has invalid steps");
  return { code, steps: steps as TransitionStepRequest[] };
}

function compileCandidate(code: string, portsDts: string): { diagnostics: string[]; javascript?: string } {
  const directory = mkdtempSync(join(tmpdir(), "kadmos-typecheck-"));
  try {
    const codePath = join(directory, "fabric.ts");
    writeFileSync(codePath, code);
    const portsPath = join(directory, "ports.d.ts");
    writeFileSync(portsPath, portsDts);
    const require = createRequire(import.meta.url);
    const tscPath = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
    const check = spawnSync(process.execPath, [tscPath, "--ignoreConfig", "--strict", "--skipLibCheck", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "ES2022", "--outDir", directory, codePath, portsPath], { encoding: "utf8", timeout: 10000 });
    return check.status === 0
      ? { diagnostics: [], javascript: readFileSync(join(directory, "fabric.js"), "utf8") }
      : { diagnostics: [(check.stdout + check.stderr).trim() || check.error?.message || "TypeScript compiler failed"] };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validateServiceClass(javascript: string, worldSpec: WorldSpec, steps: readonly TransitionStepRequest[]): void {
  const checkerUrl = new URL("../world_checker.js", import.meta.url).href;
  const script = `
    import { readFileSync } from "node:fs";
    import { Script } from "node:vm";
    import { createWorldChecker } from ${JSON.stringify(checkerUrl)};
    const { javascript, worldSpec } = JSON.parse(readFileSync(0, "utf8"));
    const exports = {};
    new Script(javascript).runInNewContext({ exports }, { timeout: 1000 });
    const Service = Object.values(exports).find(value => typeof value === "function" && /^class\\s/.test(Function.prototype.toString.call(value)));
    if (!Service) throw new Error("Candidate must export a service class");
    const checker = createWorldChecker(worldSpec);
    const observed = [];
    const port = { getState: () => checker.getState(), getContext: () => checker.getContext(), step: request => { observed.push(request); return checker.step(request); }, reset: () => { throw new Error("Candidate cannot reset checker"); } };
    const service = new Service(port);
    if (typeof service.run !== "function") throw new Error("Candidate service must implement run()");
    await service.run();
    process.stdout.write(JSON.stringify({ observed }) + "\\n");
  `;
  const child = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${dirname(new URL(checkerUrl).pathname)}`, "--input-type=module", "--eval", script], {
    input: JSON.stringify({ javascript, worldSpec }), encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024,
  });
  if (child.status !== 0) throw new Error((child.stderr || child.error?.message || "Candidate execution failed").trim());
  let observed: unknown;
  try { observed = JSON.parse(child.stdout.trim()).observed; } catch { throw new Error("Candidate execution produced invalid evidence"); }
  if (!Array.isArray(observed) || !observed.length || !isDeepStrictEqual(observed, steps)) throw new Error("Service checker.step calls must match the JSON journey exactly");
}

function compilationRepairPrompt(diagnostics: string): string {
  return `### 🛑 [Kadmos TypeScript Compilation Error]\n\nThe generated code failed typecheck against ports.d.ts:\n${diagnostics}\n\nPlease fix the TypeScript errors and provide BOTH the complete updated plan in a \`\`\`json block and service code in a \`\`\`typescript block.`;
}

function nonTerminalRepairPrompt(state: string, worldSpec: WorldSpec): string {
  const terminals = worldSpec.states.filter((item) => item.terminal).map((item) => item.id).join(", ");
  return `### 🛑 [Kadmos Non-Terminal Plan]\n\nThe plan reached state \`${state}\`, which is not a terminal state.\nTerminal states: ${terminals}\n\nPlease extend the plan so the journey reaches a terminal state and provide BOTH the complete updated plan in a \`\`\`json block and service code in a \`\`\`typescript block.`;
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
  let lastFailure: "compilation" | "malformed" | "plan" = "plan";

  for (let turn = 1; turn <= maxTurns; turn++) {
    let candidate: { code: string; steps: TransitionStepRequest[] };
    let reply: LlmCompletionResponse;
    try {
      reply = await options.provider.complete({ systemPrompt: "You are the Kadmos Fabric Builder. Obey the World constitution and output only the requested blocks.", messages });
    } catch (error) {
      const diagnostics = error instanceof Error ? error.message : String(error);
      executionTrace.push(`Turn ${turn}: provider failed: ${diagnostics}`);
      messages.push({ role: "user", content: `Provider request failed: ${diagnostics}. Retry with both a complete \`\`\`json plan and \`\`\`typescript service block.` });
      lastFailure = "plan";
      continue;
    }
    try {
      totalTokensUsed += reply.usage?.totalTokens ?? 0;
      if (reply.usage?.estimatedCostUsd !== undefined) { totalCostUsd += reply.usage.estimatedCostUsd; hasCost = true; }
      messages.push({ role: "assistant", content: reply.content });
      try { candidate = parseCandidate(reply.content); }
      catch (error) {
        const diagnostics = error instanceof Error ? error.message : String(error);
        executionTrace.push(`Turn ${turn}: malformed output: ${diagnostics}`);
        messages.push({ role: "user", content: compilationRepairPrompt(diagnostics) });
        lastFailure = "malformed";
        continue;
      }
      const compilation = compileCandidate(candidate.code, portsDts);
      if (compilation.diagnostics.length) throw new Error(compilation.diagnostics.join("; "));
      validateServiceClass(compilation.javascript!, worldSpec, candidate.steps);
    } catch (error) {
      const diagnostics = error instanceof Error ? error.message : String(error);
      executionTrace.push(`Turn ${turn}: compilation failed: ${diagnostics}`);
      messages.push({ role: "user", content: compilationRepairPrompt(diagnostics) });
      lastFailure = "compilation";
      continue;
    }

    const checker = createWorldChecker(worldSpec);
    let refused = false;
    for (const step of candidate.steps) {
      const verdict = checker.step(step);
      executionTrace.push(`Turn ${turn}: ${step.transitionId}: ${verdict.allowed ? "ACCEPTED" : `DENIED ${verdict.violation?.code ?? "UNKNOWN"}`}`);
      if (!verdict.allowed) {
        messages.push({ role: "user", content: synthesizeCegisPrompt(verdict, worldSpec) });
        lastFailure = "plan";
        refused = true;
        break;
      }
    }
    if (refused) continue;
    if (!worldSpec.states.some((state) => state.id === checker.getState() && state.terminal)) {
      executionTrace.push(`Turn ${turn}: non-terminal state ${checker.getState()}`);
      messages.push({ role: "user", content: nonTerminalRepairPrompt(checker.getState(), worldSpec) });
      lastFailure = "plan";
      continue;
    }
    mkdirSync(options.outDir, { recursive: true });
    const generatedCodePath = join(options.outDir, "fabric.ts");
    writeFileSync(generatedCodePath, candidate.code);
    writeFileSync(join(options.outDir, "journey.json"), `${JSON.stringify(candidate.steps, null, 2)}\n`);
    writeFileSync(join(options.outDir, "ports.d.ts"), portsDts);
    writeFileSync(join(options.outDir, "evidence.json"), `${JSON.stringify({ worldSpec: { name: worldSpec.name }, finalState: checker.getState(), context: checker.getContext(), turnsExecuted: turn, totalTokensUsed, executionTrace, verificationTimestamp: new Date().toISOString() }, null, 2)}\n`);
    return { success: true, turnsExecuted: turn, totalTokensUsed, ...(hasCost ? { totalCostUsd } : {}), generatedCodePath, finalVerdict: "CONSTITUTIONAL_ACCEPTED", executionTrace };
  }
  return { success: false, turnsExecuted: maxTurns, totalTokensUsed, ...(hasCost ? { totalCostUsd } : {}), finalVerdict: lastFailure === "compilation" ? "COMPILATION_FAILED" : lastFailure === "malformed" ? "MALFORMED_OUTPUT" : "MAX_TURNS_EXCEEDED", executionTrace };
}
