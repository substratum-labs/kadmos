import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import type { StepVerdict, TransitionStepRequest } from "../types/ports.js";
import type { WorldSpec } from "../types/world.js";
import { serializeWorldSpec } from "../boundary_inference.js";
import { createWorldChecker } from "../world_checker.js";
import { compileWorldSpec, parseWorldSpec } from "../world_compiler.js";
import { synthesizeCegisPrompt } from "./cegis_prompt.js";
import type { ChatMessage, ILlmProvider, LlmCompletionResponse } from "./provider.js";

export interface AgentRunOptions {
  readonly prdPath: string;
  readonly worldSpecPath?: string;
  readonly worldSpec?: WorldSpec;
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
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
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

async function validateServiceClass(javascript: string, worldSpec: WorldSpec, steps: readonly TransitionStepRequest[], turn: number, executionTrace: string[]) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kadmos-candidate-")));
  const checker = createWorldChecker(worldSpec);
  const observedSteps: TransitionStepRequest[] = [];
  let firstRefusal: StepVerdict | undefined;
  try {
    const fabricPath = join(directory, "fabric.js");
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    writeFileSync(fabricPath, javascript);
    const secretAuthToken = randomBytes(32).toString("hex");
    const script = `
      import { readSync, writeSync } from "node:fs";
      const safeStringify = JSON.stringify;
      const safeParse = JSON.parse;
      const safeWriteSync = writeSync;
      const safeReadSync = readSync;
      const safeCreate = Object.create;
      let buffered = Buffer.alloc(0);
      const readLine = () => {
        for (;;) {
          const end = buffered.indexOf(10);
          if (end !== -1) {
            const line = buffered.subarray(0, end).toString("utf8");
            buffered = buffered.subarray(end + 1);
            return line;
          }
          const chunk = Buffer.allocUnsafe(4096);
          const count = safeReadSync(4, chunk, 0, chunk.length, null);
          if (count === 0) throw new Error("Parent step channel closed");
          buffered = Buffer.concat([buffered, chunk.subarray(0, count)]);
          if (buffered.length > 1048576) throw new Error("Step channel message too large");
        }
      };
      const { auth: secretAuthToken } = safeParse(readLine());
      const module = await import(${JSON.stringify(pathToFileURL(fabricPath).href)});
      const Service = Object.values(module).find(value => typeof value === "function" && /^class\\s/.test(Function.prototype.toString.call(value)));
      if (!Service) throw new Error("Candidate must export a service class");
      let state = ${JSON.stringify(checker.getState())};
      let context = ${JSON.stringify(checker.getContext())};
      let nextSequence = 0;
      const port = {
        getState: () => state,
        getContext: () => context,
        step: request => {
          const frame = safeCreate(null);
          frame.auth = secretAuthToken;
          frame.sequence = nextSequence++;
          frame.request = request;
          safeWriteSync(3, safeStringify(frame) + "\\n");
          const verdict = safeParse(readLine());
          state = verdict.currentState;
          context = verdict.context;
          return verdict;
        },
        reset: () => { throw new Error("Candidate cannot reset checker"); },
      };
      const service = new Service(port);
      if (typeof service.run !== "function") throw new Error("Candidate service must implement run()");
      await service.run();
    `;
    const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${directory}`, "--input-type=module", "--eval", script], {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], timeout: 2000, killSignal: "SIGKILL",
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    let rpcError: Error | undefined;
    let nextSequence = 0;
    let pending = "";
    const requestPipe = child.stdio[3] as Readable;
    const responsePipe = child.stdio[4] as Writable;
    const failRpc = (error: Error) => {
      if (!rpcError) rpcError = error;
      child.kill();
    };
    requestPipe.on("error", failRpc);
    responsePipe.on("error", failRpc);
    requestPipe.setEncoding("utf8");
    requestPipe.on("data", (chunk: string) => {
      if (rpcError) return;
      pending += chunk;
      if (pending.length > 1048576) {
        failRpc(new Error("Step request too large"));
        return;
      }
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1 && !rpcError) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const message = JSON.parse(line) as { auth?: unknown; sequence?: unknown; request?: TransitionStepRequest };
          if (message?.auth !== secretAuthToken) throw new Error("Unauthenticated step request");
          if (message.sequence !== nextSequence) throw new Error("Out-of-order step request");
          const request = message.request;
          if (!request || typeof request !== "object") throw new Error("Invalid step request");
          nextSequence++;
          observedSteps.push(request);
          const verdict = checker.step(request);
          executionTrace.push(`Turn ${turn}: ${request.transitionId}: ${verdict.allowed ? "ACCEPTED" : `DENIED ${verdict.violation?.code ?? "UNKNOWN"}`}`);
          if (!verdict.allowed && !firstRefusal) firstRefusal = verdict;
          responsePipe.write(`${JSON.stringify(verdict)}\n`);
        } catch (error) {
          failRpc(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    responsePipe.write(`${JSON.stringify({ auth: secretAuthToken })}\n`);
    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally { responsePipe.end(); }
    if (rpcError) throw rpcError;
    if (!observedSteps.length || !isDeepStrictEqual(observedSteps, steps)) throw new Error(`Service checker.step calls must match the JSON journey exactly${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    if (exitCode !== 0) throw new Error(stderr.trim() || "Candidate execution failed");
    return { checker, firstRefusal };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  if (!options.worldSpec && !options.worldSpecPath) throw new Error("Either worldSpec or worldSpecPath is required");
  const worldSpec = options.worldSpec ?? parseWorldSpec(readFileSync(options.worldSpecPath!, "utf8"));
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
    let validation: Awaited<ReturnType<typeof validateServiceClass>>;
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
      validation = await validateServiceClass(compilation.javascript!, worldSpec, candidate.steps, turn, executionTrace);
    } catch (error) {
      const diagnostics = error instanceof Error ? error.message : String(error);
      executionTrace.push(`Turn ${turn}: compilation failed: ${diagnostics}`);
      messages.push({ role: "user", content: compilationRepairPrompt(diagnostics) });
      lastFailure = "compilation";
      continue;
    }

    const { checker, firstRefusal } = validation;
    if (firstRefusal) {
      messages.push({ role: "user", content: synthesizeCegisPrompt(firstRefusal, worldSpec) });
      lastFailure = "plan";
      continue;
    }
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
    if (options.worldSpec && !options.worldSpecPath) writeFileSync(join(options.outDir, "world.spec.yaml"), serializeWorldSpec(worldSpec));
    return { success: true, turnsExecuted: turn, totalTokensUsed, ...(hasCost ? { totalCostUsd } : {}), generatedCodePath, finalVerdict: "CONSTITUTIONAL_ACCEPTED", executionTrace };
  }
  return { success: false, turnsExecuted: maxTurns, totalTokensUsed, ...(hasCost ? { totalCostUsd } : {}), finalVerdict: lastFailure === "compilation" ? "COMPILATION_FAILED" : lastFailure === "malformed" ? "MALFORMED_OUTPUT" : "MAX_TURNS_EXCEEDED", executionTrace };
}
