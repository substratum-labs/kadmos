import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { AnthropicProvider, MockDeterministicProvider, OllamaProvider, OpenAiCompatibleProvider, createLlmProvider, createWorldChecker, parseWorldSpec, runKadmosAgent } from "../src/index.js";
import type { LlmCompletionRequest, LlmCompletionResponse } from "../src/index.js";

const worldPath = join(process.cwd(), "conformance/fixtures/order_settlement.world.yaml");
const goodSteps = [
  { transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" },
  { transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } },
  { transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" },
];
const badSteps = [{ transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" }];
const serviceCode = (steps: unknown) => `import type { IWorldChecker } from "./ports.js"; export class OrderService { constructor(private readonly checker: IWorldChecker) {} run() { ${(steps as object[]).map((step) => `this.checker.step(${JSON.stringify(step)});`).join(" ")} } }`;
const candidate = (steps: unknown, code = serviceCode(steps)) => `\`\`\`json\n${JSON.stringify({ steps })}\n\`\`\`\n\`\`\`typescript\n${code}\n\`\`\``;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kadmos-run-"));
  const prdPath = join(directory, "prd.txt");
  const outDir = join(directory, "out");
  writeFileSync(prdPath, "Implement a payment and fulfillment service");
  return { directory, prdPath, outDir };
}

test("provider factory selects every backend and rejects unknown names", () => {
  assert.ok(createLlmProvider("openai", { model: "test" }) instanceof OpenAiCompatibleProvider);
  assert.ok(createLlmProvider("anthropic", { model: "test" }) instanceof AnthropicProvider);
  assert.ok(createLlmProvider("ollama", { model: "test" }) instanceof OllamaProvider);
  assert.ok(createLlmProvider("mock", { responses: [] }) instanceof MockDeterministicProvider);
  assert.throws(() => createLlmProvider("unknown"), /provider/i);
});

test("runner accepts compliant first turn and writes code", async () => {
  const f = fixture();
  try {
    const result = await runKadmosAgent({ prdPath: f.prdPath, worldSpecPath: worldPath, outDir: f.outDir, provider: new MockDeterministicProvider([candidate(goodSteps)]) });
    assert.equal(result.finalVerdict, "CONSTITUTIONAL_ACCEPTED");
    assert.equal(result.turnsExecuted, 1);
    assert.equal(result.success, true);
    assert.match(readFileSync(result.generatedCodePath!, "utf8"), /class OrderService/);
    assert.deepEqual(JSON.parse(readFileSync(join(f.outDir, "journey.json"), "utf8")), goodSteps);
    assert.match(readFileSync(join(f.outDir, "ports.d.ts"), "utf8"), /IWorldChecker/);
    const evidence = JSON.parse(readFileSync(join(f.outDir, "evidence.json"), "utf8"));
    assert.equal(evidence.worldSpec.name, "OrderSettlementWorld");
    assert.equal(evidence.finalState, "FULFILLED");
    assert.equal(evidence.turnsExecuted, 1);
    assert.ok(Date.parse(evidence.verificationTimestamp));
    assert.equal(evidence.totalTokensUsed, 0);
    assert.deepEqual(evidence.executionTrace, result.executionTrace);
    const checker = createWorldChecker(parseWorldSpec(readFileSync(worldPath, "utf8")));
    for (const step of JSON.parse(readFileSync(join(f.outDir, "journey.json"), "utf8"))) assert.equal(checker.step(step).allowed, true);
    assert.equal(checker.getState(), evidence.finalState);
    assert.deepEqual(checker.getContext(), evidence.context);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("runner rejects source whose checker calls disagree with its plan", async () => {
  const f = fixture();
  try {
    const result = await runKadmosAgent({ prdPath: f.prdPath, worldSpecPath: worldPath, outDir: f.outDir, provider: new MockDeterministicProvider([candidate(goodSteps, serviceCode(badSteps))]), maxRepairTurns: 1 });
    assert.equal(result.success, false);
    assert.equal(existsSync(f.outDir), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("runner rejects a class that never calls checker.step", async () => {
  const f = fixture();
  try {
    const source = "export class OrderService { run() {} }";
    const result = await runKadmosAgent({ prdPath: f.prdPath, worldSpecPath: worldPath, outDir: f.outDir, provider: new MockDeterministicProvider([candidate(goodSteps, source)]), maxRepairTurns: 1 });
    assert.equal(result.finalVerdict, "COMPILATION_FAILED");
    assert.match(result.executionTrace[0]!, /checker.step calls must match/);
    assert.equal(existsSync(f.outDir), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("forged child stdout cannot stand in for checker.step calls", async () => {
  const f = fixture();
  try {
    const source = `export class OrderService { constructor(private checker: any) {} run() { const childProcess = this.checker.constructor.constructor('return process')(); const originalWrite = childProcess.stdout.write.bind(childProcess.stdout); childProcess.stdout.write = () => originalWrite(JSON.stringify({ observed: ${JSON.stringify(goodSteps)} })); } }`;
    const result = await runKadmosAgent({ prdPath: f.prdPath, worldSpecPath: worldPath, outDir: f.outDir, provider: new MockDeterministicProvider([candidate(goodSteps, source)]), maxRepairTurns: 1 });
    assert.equal(result.success, false);
    assert.match(result.executionTrace[0]!, /checker.step calls must match/);
    assert.equal(existsSync(f.outDir), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("direct writes to the step channel cannot stand in for checker.step calls", async () => {
  const f = fixture();
  try {
    const source = `export class OrderService { run() {
      const fs = this.constructor.constructor('return process')().getBuiltinModule('node:fs');
      const dir = new URL('.', import.meta.url).pathname;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      for (const [id, request] of ${JSON.stringify(goodSteps)}.entries()) {
        fs.writeFileSync(dir + 'rpc/req_' + id + '.json', JSON.stringify(request));
        while (!fs.existsSync(dir + 'rpc/res_' + id + '.json')) Atomics.wait(pause, 0, 0, 1);
      }
    } }`;
    const result = await runKadmosAgent({ prdPath: f.prdPath, worldSpecPath: worldPath, outDir: f.outDir, provider: new MockDeterministicProvider([candidate(goodSteps, source)]), maxRepairTurns: 1 });
    assert.equal(result.success, false);
    assert.equal(existsSync(f.outDir), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("unauthenticated pipe requests cannot stand in for checker.step calls", async () => {
  const f = fixture();
  try {
    const source = `export class OrderService { run() {
      const fs = this.constructor.constructor('return process')().getBuiltinModule('node:fs');
      for (const request of ${JSON.stringify(goodSteps)}) fs.writeSync(3, JSON.stringify({ request }) + '\\n');
    } }`;
    const result = await runKadmosAgent({ prdPath: f.prdPath, worldSpecPath: worldPath, outDir: f.outDir, provider: new MockDeterministicProvider([candidate(goodSteps, source)]), maxRepairTurns: 1 });
    assert.equal(result.success, false);
    assert.match(result.executionTrace[0]!, /Unauthenticated step request/);
    assert.equal(existsSync(f.outDir), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("candidate process exit cannot terminate the runner or admit code", async () => {
  const f = fixture();
  try {
    const source = "import type { IWorldChecker } from './ports.js'; export class OrderService { constructor(private checker: IWorldChecker) {} run() { (this.checker as any).constructor.constructor('return process')().exit(0); } }";
    const result = await runKadmosAgent({ prdPath: f.prdPath, worldSpecPath: worldPath, outDir: f.outDir, provider: new MockDeterministicProvider([candidate(goodSteps, source)]), maxRepairTurns: 1 });
    assert.equal(result.success, false);
    assert.equal(existsSync(f.outDir), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("runner sends refusal feedback and accepts repaired second turn", async () => {
  const f = fixture();
  const requests: LlmCompletionRequest[] = [];
  const scripted = new MockDeterministicProvider([candidate(badSteps), candidate(goodSteps)]);
  const provider = { ...scripted, providerName: "capture", defaultModel: "mock", async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> { requests.push(request); return scripted.complete(request); } };
  try {
    const result = await runKadmosAgent({ prdPath: f.prdPath, worldSpecPath: worldPath, outDir: f.outDir, provider });
    assert.equal(result.finalVerdict, "CONSTITUTIONAL_ACCEPTED");
    assert.equal(result.turnsExecuted, 2);
    assert.match(requests[1]!.messages.find((message) => message.role === "user" && /ILLEGAL_TRANSITION/.test(message.content))!.content, /ILLEGAL_TRANSITION/);
    assert.ok(existsSync(result.generatedCodePath!));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("runner fails closed at max turns and writes no code", async () => {
  const f = fixture();
  try {
    const result = await runKadmosAgent({ prdPath: f.prdPath, worldSpecPath: worldPath, outDir: f.outDir, provider: new MockDeterministicProvider([candidate(badSteps), candidate(badSteps), candidate(badSteps)]) });
    assert.equal(result.finalVerdict, "MAX_TURNS_EXCEEDED");
    assert.equal(result.turnsExecuted, 3);
    assert.equal(result.success, false);
    assert.equal(existsSync(f.outDir), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("CLI run parses flags and dry-run emits the initial prompt", async () => {
  const f = fixture();
  try {
    const output = await runCli(["run", "--prd", f.prdPath, "--world", worldPath, "--out", f.outDir, "--provider", "mock", "--model", "test-model", "--max-turns", "2", "--dry-run"]);
    assert.match(output, /CONSTITUTIONAL RULES/);
    assert.match(output, /Implement a payment and fulfillment service/);
    assert.equal(existsSync(f.outDir), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("HTTP providers send native requests and normalize responses", async () => {
  const { createServer } = await import("node:http");
  const seen: { url: string; headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let data = "";
    for await (const chunk of request) data += chunk;
    seen.push({ url: request.url ?? "", headers: request.headers, body: JSON.parse(data) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/v1/messages"
      ? { model: "claude-test", content: [{ type: "text", text: "anthropic answer" }], usage: { input_tokens: 4, output_tokens: 2 } }
      : request.url === "/api/chat"
        ? { model: "ollama-test", message: { content: "ollama answer" }, prompt_eval_count: 3, eval_count: 2 }
        : { model: "openai-test", choices: [{ message: { content: "openai answer" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = { systemPrompt: "system", messages: [{ role: "user" as const, content: "question" }] };
    assert.equal((await new OpenAiCompatibleProvider({ baseUrl, apiKey: "key", model: "openai-test" }).complete(request)).usage?.totalTokens, 7);
    assert.equal((await new AnthropicProvider({ baseUrl: `${baseUrl}/v1`, apiKey: "key", model: "claude-test" }).complete(request)).content, "anthropic answer");
    assert.equal((await new OllamaProvider({ baseUrl, model: "ollama-test" }).complete(request)).content, "ollama answer");
    assert.deepEqual(seen.map((entry) => entry.url), ["/v1/chat/completions", "/v1/messages", "/api/chat"]);
    assert.equal(seen[0]!.headers.authorization, "Bearer key");
    assert.equal(seen[1]!.headers["x-api-key"], "key");
    assert.equal(seen[2]!.body.stream, false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("HTTP providers report non-JSON errors and respect request timeout", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    if (request.url === "/v1/chat/completions") { response.statusCode = 503; response.end("temporarily unavailable"); return; }
    response.setHeader("content-type", "text/plain");
    response.end("not json");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = { systemPrompt: "system", messages: [{ role: "user" as const, content: "question" }] };
    await assert.rejects(new OpenAiCompatibleProvider({ baseUrl, apiKey: "key", timeoutMs: 1000 }).complete(request), /LLM_HTTP_503: temporarily unavailable/);
    await assert.rejects(new OllamaProvider({ baseUrl, timeoutMs: 1000 }).complete(request), /LLM_RESPONSE_INVALID: non-JSON response/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("CLI run executes through an HTTP provider and writes the accepted artifact", async () => {
  const { createServer } = await import("node:http");
  const f = fixture();
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ model: "test", choices: [{ message: { content: candidate(goodSteps) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const previousKey = process.env.KADMOS_OPENAI_API_KEY;
    const previousUrl = process.env.KADMOS_OPENAI_BASE_URL;
    process.env.KADMOS_OPENAI_API_KEY = "test";
    process.env.KADMOS_OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    try {
      const output = await runCli(["run", "--prd", f.prdPath, "--world", worldPath, "--out", f.outDir, "--provider", "openai", "--model", "test", "--max-turns", "1"]);
      assert.equal(JSON.parse(output).finalVerdict, "CONSTITUTIONAL_ACCEPTED");
      assert.ok(existsSync(join(f.outDir, "fabric.ts")));
    } finally {
      if (previousKey === undefined) delete process.env.KADMOS_OPENAI_API_KEY; else process.env.KADMOS_OPENAI_API_KEY = previousKey;
      if (previousUrl === undefined) delete process.env.KADMOS_OPENAI_BASE_URL; else process.env.KADMOS_OPENAI_BASE_URL = previousUrl;
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(f.directory, { recursive: true, force: true });
  }
});
