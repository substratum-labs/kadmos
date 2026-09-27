import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { inferBoundary, serializeWorldSpec } from "../boundary_inference.js";
import { applyLegislationPatch, synthesizeDilemmas } from "../dilemma_synthesis.js";
import { compileWorldSpec, compileWorldSpecPython, parseWorldSpec } from "../world_compiler.js";
import { createWorldChecker } from "../world_checker.js";
import type { WorldSpec } from "../types/world.js";

const protocolVersion = "2024-11-05";

const tools = [
  { name: "kadmos_infer", description: "Infers Candidate World IR and legislative dilemmas from an unstructured PRD.", inputSchema: {
    type: "object", properties: { prd: { type: "string", description: "The product requirement document or specification text." }, name: { type: "string", description: "Optional name for the generated world model." } }, required: ["prd"],
  } },
  { name: "kadmos_legislate", description: "Applies human legislative decisions (Option A vs Option B) to a World IR model.", inputSchema: {
    type: "object", properties: { world: { type: "object", description: "The WorldSpec JSON object to patch." }, resolutions: { type: "array", description: "Array of dilemma resolutions.", items: { type: "object", properties: { dilemmaId: { type: "string" }, choice: { type: "string", enum: ["A", "B"] } }, required: ["dilemmaId", "choice"] } } }, required: ["world", "resolutions"],
  } },
  { name: "kadmos_compile", description: "Compiles a World IR specification into multi-language seam interfaces and runtime gatekeepers.", inputSchema: {
    type: "object", properties: { world: { type: "object", description: "The WorldSpec JSON object." }, lang: { type: "string", enum: ["ts", "python", "all"], default: "all" } }, required: ["world"],
  } },
  { name: "kadmos_step", description: "Validates a state transition and proposed directive against a World IR specification.", inputSchema: {
    type: "object", properties: { sessionId: { type: "string", description: "Session identifier for a persistent checker." }, world: { type: "object", description: "Required for a new session or stateless step." }, currentState: { type: "string", description: "Optional asserted current state." }, context: { type: "object", description: "Initial context for a new checker or asserted context for an existing session." }, transitionId: { type: "string", description: "The transition ID being requested." }, eventPayload: { type: "object", description: "Optional payload accompanying the event." }, proposedDirective: { type: ["string", "null"], description: "Optional proposed side-effect directive." } }, required: ["transitionId"],
  } },
] as const;

class InvalidParams extends Error {}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function params(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new InvalidParams("Expected object params");
  return value;
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new InvalidParams(`Expected string ${name}`);
  return value;
}
function world(value: unknown): WorldSpec {
  if (!record(value)) throw new InvalidParams("Expected object world");
  try { return parseWorldSpec(serializeWorldSpec(value as unknown as WorldSpec)); }
  catch (error) { throw new InvalidParams(`Invalid world spec: ${error instanceof Error ? error.message : String(error)}`); }
}

type Checker = ReturnType<typeof createWorldChecker>;
type Session = { checker: Checker; world: WorldSpec };

function contextMatches(actual: Record<string, number | string>, expected: Record<string, number | string>): boolean {
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return actualKeys.length === expectedKeys.length && actualKeys.every((key) => Object.hasOwn(expected, key) && expected[key] === actual[key]);
}

function executeTool(name: string, args: Record<string, unknown>, sessions: Map<string, Session>): unknown {
  if (name === "kadmos_infer") {
    const prd = string(args.prd, "prd");
    const modelName = args.name === undefined ? undefined : string(args.name, "name");
    const inferred = inferBoundary(prd, modelName === undefined ? {} : { name: modelName });
    return { worldSpec: inferred.worldSpec, worldCandidates: inferred.worldCandidates, fabricCandidates: inferred.fabricCandidates, dilemmas: synthesizeDilemmas(inferred) };
  }
  if (name === "kadmos_legislate") {
    let spec = world(args.world);
    if (!Array.isArray(args.resolutions)) throw new InvalidParams("Expected array resolutions");
    const triggers: Record<string, string> = { "DIL-001": "cancel payment", "DIL-002": "timeout RPC", "DIL-003": "refund webhook" };
    const requestedIds = args.resolutions.map((value) => string(params(value).dilemmaId, "dilemmaId"));
    for (const id of requestedIds) if (!Object.hasOwn(triggers, id)) throw new Error(`Unknown dilemma: ${id}`);
    const available = synthesizeDilemmas({ source: "heuristic", inputContent: requestedIds.map((id) => triggers[id]).join(" "), worldSpec: spec, worldYaml: "", portsDts: "", worldCandidates: [], fabricCandidates: [] });
    const appliedDecisions: { dilemmaId: string; choice: "A" | "B" }[] = [];
    for (const value of args.resolutions) {
      const resolution = params(value);
      const dilemmaId = string(resolution.dilemmaId, "dilemmaId");
      if (resolution.choice !== "A" && resolution.choice !== "B") throw new InvalidParams("Expected choice A or B");
      const dilemma = available.find((item) => item.id === dilemmaId);
      if (!dilemma) throw new Error(`Unknown dilemma: ${dilemmaId}`);
      if (resolution.choice === "A") spec = applyLegislationPatch(spec, dilemma.optionA.patch);
      appliedDecisions.push({ dilemmaId, choice: resolution.choice });
    }
    return { worldSpec: spec, appliedDecisions };
  }
  if (name === "kadmos_compile") {
    const spec = world(args.world);
    const lang = args.lang ?? "all";
    if (lang !== "ts" && lang !== "python" && lang !== "all") throw new InvalidParams("Expected lang ts, python or all");
    const files: Record<string, string> = {};
    if (lang === "ts" || lang === "all") {
      const projection = compileWorldSpec(spec);
      files["ports.d.ts"] = projection.portsDts;
      files["world_checker.ts"] = projection.worldCheckerTs;
    }
    if (lang === "python" || lang === "all") {
      const projection = compileWorldSpecPython(spec);
      files["ports.py"] = projection.portsPy;
      files["world_checker.py"] = projection.worldCheckerPy;
    }
    return { files };
  }
  if (name === "kadmos_step") {
    const transitionId = string(args.transitionId, "transitionId");
    const sessionId = args.sessionId === undefined ? undefined : string(args.sessionId, "sessionId");
    if (sessionId === "") throw new InvalidParams("Expected nonempty sessionId");
    if (args.context !== undefined && (!record(args.context) || Object.values(args.context).some((value) => !Number.isSafeInteger(value)))) throw new InvalidParams("Expected integer context");
    const currentState = args.currentState === undefined ? undefined : string(args.currentState, "currentState");
    if (args.eventPayload !== undefined && !record(args.eventPayload)) throw new InvalidParams("Expected object eventPayload");
    if (args.proposedDirective !== undefined && args.proposedDirective !== null && typeof args.proposedDirective !== "string") throw new InvalidParams("Expected string or null proposedDirective");
    const existing = sessionId === undefined ? undefined : sessions.get(sessionId);
    let checker: Checker;
    if (existing) {
      if (args.world !== undefined && !isDeepStrictEqual(world(args.world), existing.world)) throw new InvalidParams("Session world mismatch");
      checker = existing.checker;
      if (args.context !== undefined && !contextMatches(args.context as Record<string, number>, checker.getContext())) throw new InvalidParams("Session context mismatch");
    } else {
      const spec = world(args.world);
      checker = createWorldChecker(spec, (args.context ?? {}) as Record<string, number>);
      if (currentState !== undefined && currentState !== checker.getState()) throw new InvalidParams("currentState does not match initial state");
      if (sessionId !== undefined) sessions.set(sessionId, { checker, world: spec });
    }
    if (currentState !== undefined && currentState !== checker.getState()) throw new InvalidParams("Session currentState mismatch");
    const verdict = checker.step({ transitionId, ...(args.eventPayload !== undefined ? { eventPayload: args.eventPayload as Record<string, unknown> } : {}), ...(args.proposedDirective !== undefined ? { proposedDirective: args.proposedDirective as string | null } : {}) });
    return sessionId === undefined ? verdict : { ...verdict, sessionId };
  }
  throw new InvalidParams(`Unknown tool: ${name}`);
}

function toolCall(value: unknown, sessions: Map<string, Session>): unknown {
  const call = params(value);
  const name = string(call.name, "name");
  if (!tools.some((tool) => tool.name === name)) throw new InvalidParams(`Unknown tool: ${name}`);
  const args = call.arguments === undefined ? {} : params(call.arguments);
  try {
    const result = executeTool(name, args, sessions);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  } catch (error) {
    if (error instanceof InvalidParams) throw error;
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

export function runMcpServer(options: { in?: NodeJS.ReadableStream; out?: NodeJS.WritableStream } = {}): void {
  const input: NodeJS.ReadableStream = options.in ?? process.stdin;
  const output: NodeJS.WritableStream = options.out ?? process.stdout;
  const sessions = new Map<string, Session>();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const send = (message: unknown) => { const payload = JSON.stringify(message).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); output.write(`${payload}\n`); };
  const handleLine = (line: string) => {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    if (!record(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
      send({ jsonrpc: "2.0", id: record(value) && (typeof value.id === "string" || typeof value.id === "number" || value.id === null) ? value.id : null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    const id = value.id;
    const notification = id === undefined;
    if (notification) return;
    if (typeof id !== "string" && typeof id !== "number" && id !== null) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    try {
      let result: unknown;
      switch (value.method) {
        case "initialize": params(value.params); result = { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "kadmos", version: "0.0.0" } }; break;
        case "ping": result = {}; break;
        case "tools/list": result = { tools }; break;
        case "tools/call": result = toolCall(value.params, sessions); break;
        default: send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }); return;
      }
      send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      send({ jsonrpc: "2.0", id, error: { code: error instanceof InvalidParams ? -32602 : -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  };
  input.on("data", (chunk: Buffer | string) => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      handleLine(line);
    }
  });
  input.on("end", () => {
    pending += decoder.end();
    if (pending.length) handleLine(pending);
  });
}
