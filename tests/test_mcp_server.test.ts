import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runMcpServer } from "../src/mcp/server.js";

const prd = "Order CREATED to PAYMENT_PENDING. Cancel payment capture after timeout; retry refund webhook. Escrow balance and order amount.";
const world = {
  version: "kadmos.world.v0", name: "Steps",
  states: [{ id: "CREATED", initial: true }, { id: "PAID" }],
  context: { amount: { type: "integer", min: 0, max: 100, default: 5 } },
  invariants: [{ id: "NONNEGATIVE", predicate: "amount >= 0" }],
  transitions: [{ id: "PAY", from: "CREATED", to: "PAID", guard: true, directive: "DISPATCH_PAYMENT", effects: [] }],
};

async function session(requests: string[]): Promise<unknown[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => chunks.push(chunk));
  runMcpServer({ in: input, out: output });
  input.end(requests.join("\n") + "\n");
  await new Promise<void>((resolve) => input.on("end", resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  return chunks.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

const request = (id: number, method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const call = (id: number, name: string, args: unknown) => request(id, "tools/call", { name, arguments: args });
function result(response: any): any { return JSON.parse(response.result.content[0].text); }

test("stdio handshake, notification, ping and EOF", async () => {
  const responses: any[] = await session([
    request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    request(2, "ping"),
  ]) as any[];
  assert.deepEqual(responses.map((item) => item.id), [1, 2]);
  assert.deepEqual(responses[0].result, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "kadmos", version: "0.0.0" } });
  assert.deepEqual(responses[1].result, {});
});

test("tools/list exposes four complete schemas", async () => {
  const [response]: any[] = await session([request(1, "tools/list")]) as any[];
  const tools: any[] = response.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["kadmos_infer", "kadmos_legislate", "kadmos_compile", "kadmos_step"]);
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.inputSchema.properties);
    assert.ok(Array.isArray(tool.inputSchema.required));
  }
  assert.deepEqual(tools[3].inputSchema.required, ["transitionId"]);
});

test("infer, legislate and compile use existing World APIs", async () => {
  const [inferred]: any[] = await session([call(1, "kadmos_infer", { prd, name: "Orders" })]) as any[];
  assert.equal(inferred.result.isError, false);
  const inference = result(inferred);
  assert.equal(inference.worldSpec.name, "Orders");
  assert.ok(inference.worldCandidates.length > 0);
  assert.ok(inference.dilemmas.length > 0);
  const [legislated]: any[] = await session([call(2, "kadmos_legislate", { world: inference.worldSpec, resolutions: [{ dilemmaId: "DIL-001", choice: "A" }] })]) as any[];
  assert.equal(legislated.result.isError, false);
  assert.ok(result(legislated).worldSpec.states.some((state: any) => state.id === "ARBITRATION"));
  assert.deepEqual(result(legislated).appliedDecisions, [{ dilemmaId: "DIL-001", choice: "A" }]);
  const [compiled]: any[] = await session([call(3, "kadmos_compile", { world })]) as any[];
  assert.equal(compiled.result.isError, false);
  assert.deepEqual(Object.keys(result(compiled).files), ["ports.d.ts", "world_checker.ts", "ports.py", "world_checker.py"]);
});

test("step permits valid transition and rejects directive and transition violations", async () => {
  const args = { world, currentState: "CREATED", context: { amount: 5 }, transitionId: "PAY" };
  const responses: any[] = await session([
    call(1, "kadmos_step", { ...args, proposedDirective: "DISPATCH_PAYMENT" }),
    call(2, "kadmos_step", { ...args, proposedDirective: "DISPATCH_OTHER" }),
    call(3, "kadmos_step", { ...args, transitionId: "MISSING" }),
  ]) as any[];
  assert.equal(result(responses[0]).allowed, true);
  assert.equal(result(responses[0]).currentState, "PAID");
  assert.equal(result(responses[1]).allowed, false);
  assert.equal(result(responses[1]).directiveAllowed, null);
  assert.equal(result(responses[2]).violation.code, "INVALID_TRANSITION");
  assert.equal(result(responses[2]).violation.shortestCounterexampleTrace.length, 1);
});

test("malformed JSON, unknown method and invalid params have standard errors", async () => {
  const responses: any[] = await session(["{", request(2, "missing"), request(3, "tools/call", { name: "kadmos_compile", arguments: {} })]) as any[];
  assert.deepEqual(responses.map((item) => item.error.code), [-32700, -32601, -32602]);
});

test("both CLI entry points exchange JSON frames without stdout diagnostics", () => {
  for (const binary of ["bin/kadmos.js", "bin/kadmos-mcp.js"]) {
    const args = binary.endsWith("kadmos.js") ? [binary, "mcp"] : [binary];
    const child = spawnSync(process.execPath, args, { input: `${request(1, "ping")}\n`, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, "");
    assert.deepEqual(JSON.parse(child.stdout.trim()), { jsonrpc: "2.0", id: 1, result: {} });
  }
});

test("step sessions preserve history and reject forged state or context", async () => {
  const responses: any[] = await session([
    call(1, "kadmos_step", { sessionId: "journey", world, transitionId: "PAY", proposedDirective: "DISPATCH_PAYMENT" }),
    call(2, "kadmos_step", { sessionId: "journey", transitionId: "MISSING" }),
    call(3, "kadmos_step", { sessionId: "journey", currentState: "CREATED", transitionId: "MISSING" }),
    call(4, "kadmos_step", { sessionId: "journey", context: { amount: 99 }, transitionId: "MISSING" }),
    call(5, "kadmos_step", { world, currentState: "PAID", transitionId: "MISSING" }),
  ]) as any[];
  assert.equal(result(responses[0]).sessionId, "journey");
  assert.equal(result(responses[1]).violation.shortestCounterexampleTrace.length, 2);
  assert.deepEqual(responses.slice(2).map(item => item.error.code), [-32602, -32602, -32602]);
});

test("invalid World documents produce invalid params and Unicode separators stay within one frame", async () => {
  const invalid = { ...world, states: [] };
  const unicode = request(2, "tools/call", { name: "kadmos_infer", arguments: { prd: `alpha\u2028beta\u2029gamma` } });
  const responses: any[] = await session([call(1, "kadmos_compile", { world: invalid }), unicode]) as any[];
  assert.equal(responses[0].error.code, -32602);
  assert.match(responses[0].error.message, /Invalid world spec/);
  assert.equal(responses[1].id, 2);
  assert.equal(responses[1].result.isError, false);
  assert.equal(responses.length, 2);
});
