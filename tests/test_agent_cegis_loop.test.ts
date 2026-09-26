import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MockDeterministicProvider, runKadmosAgent } from "../src/index.js";
import type { LlmCompletionRequest } from "../src/index.js";

const worldSpecPath = join(process.cwd(), "conformance/fixtures/order_settlement.world.yaml");
const payment = { transitionId: "INITIATE_PAYMENT", proposedDirective: "DISPATCH_PAYMENT_GATEWAY" };
const confirm = { transitionId: "CONFIRM_PAYMENT", eventPayload: { captured_amount: 5000 } };
const dispatch = { transitionId: "DISPATCH_GOODS", proposedDirective: "INVOKE_LOGISTICS_DISPATCH" };
const code = "export class OrderService { constructor(checker: unknown) { if (!checker) throw new Error('checker required'); } }";
const candidate = (steps: unknown, source = code) => `\`\`\`json\n${JSON.stringify({ steps })}\n\`\`\`\n\`\`\`typescript\n${source}\n\`\`\``;

async function run(responses: string[], maxRepairTurns = 3) {
  const directory = mkdtempSync(join(tmpdir(), "kadmos-cegis-"));
  const prdPath = join(directory, "prd.txt");
  const outDir = join(directory, "out");
  writeFileSync(prdPath, "Complete payment and fulfillment");
  const requests: LlmCompletionRequest[] = [];
  const scripted = new MockDeterministicProvider(responses);
  const provider = {
    providerName: "capture", defaultModel: "mock",
    async complete(request: LlmCompletionRequest) {
      requests.push({ ...request, messages: [...request.messages] });
      return scripted.complete(request);
    },
  };
  try {
    const result = await runKadmosAgent({ prdPath, worldSpecPath, outDir, provider, maxRepairTurns });
    return { result, requests, outputExists: existsSync(outDir) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("typecheck error receives compilation feedback and repairs on turn two", async () => {
  const { result, requests } = await run([candidate([payment, confirm, dispatch], "export class OrderService { broken: MissingType; }"), candidate([payment, confirm, dispatch])]);
  assert.equal(result.finalVerdict, "CONSTITUTIONAL_ACCEPTED");
  assert.equal(result.turnsExecuted, 2);
  assert.match(requests[1]!.messages.at(-1)!.content, /Kadmos TypeScript Compilation Error[\s\S]*MissingType[\s\S]*Please fix the TypeScript errors/);
});

test("non-terminal plan receives state feedback and reaches terminal on turn two", async () => {
  const { result, requests } = await run([candidate([payment, confirm]), candidate([payment, confirm, dispatch])]);
  assert.equal(result.finalVerdict, "CONSTITUTIONAL_ACCEPTED");
  assert.equal(result.turnsExecuted, 2);
  assert.match(requests[1]!.messages.at(-1)!.content, /Kadmos Non-Terminal Plan[\s\S]*`PAID`[\s\S]*FULFILLED[\s\S]*CANCELLED/);
});

test("illegal transition refusal guides the second turn to acceptance", async () => {
  const { result, requests } = await run([candidate([dispatch]), candidate([payment, confirm, dispatch])]);
  assert.equal(result.finalVerdict, "CONSTITUTIONAL_ACCEPTED");
  assert.equal(result.turnsExecuted, 2);
  assert.match(requests[1]!.messages.at(-1)!.content, /ILLEGAL_TRANSITION/);
});

test("three compilation failures exhaust the budget with a compilation verdict", async () => {
  const bad = candidate([payment, confirm, dispatch], "export class OrderService { broken: MissingType; }");
  const { result, requests, outputExists } = await run([bad, bad, bad]);
  assert.equal(result.finalVerdict, "COMPILATION_FAILED");
  assert.equal(result.turnsExecuted, 3);
  assert.equal(requests.length, 3);
  assert.equal(outputExists, false);
});

test("a candidate without an exported service class receives repair feedback", async () => {
  const { result, requests } = await run([candidate([payment, confirm, dispatch], "class OrderService {}"), candidate([payment, confirm, dispatch])]);
  assert.equal(result.finalVerdict, "CONSTITUTIONAL_ACCEPTED");
  assert.equal(result.turnsExecuted, 2);
  assert.match(requests[1]!.messages.at(-1)!.content, /Kadmos TypeScript Compilation Error[\s\S]*export a service class/);
});


test("malformed candidate blocks receive repair feedback instead of aborting", async () => {
  const { result, requests } = await run(["not a candidate", candidate([payment, confirm, dispatch])]);
  assert.equal(result.finalVerdict, "CONSTITUTIONAL_ACCEPTED");
  assert.equal(result.turnsExecuted, 2);
  assert.match(requests[1]!.messages.at(-1)!.content, /Candidate requires TypeScript and JSON plan blocks/);
});

test("non-terminal exhaustion reports max turns rather than compilation failure", async () => {
  const partial = candidate([payment, confirm]);
  const { result, requests } = await run([partial, partial, partial]);
  assert.equal(result.finalVerdict, "MAX_TURNS_EXCEEDED");
  assert.equal(result.turnsExecuted, 3);
  assert.equal(requests.length, 3);
});

test("a service constructor that rejects the checker is repaired on the next turn", async () => {
  const broken = "export class OrderService { constructor(_checker: unknown) { throw new Error('cannot instantiate'); } }";
  const { result, requests } = await run([candidate([payment, confirm, dispatch], broken), candidate([payment, confirm, dispatch])]);
  assert.equal(result.finalVerdict, "CONSTITUTIONAL_ACCEPTED");
  assert.equal(result.turnsExecuted, 2);
  assert.match(requests[1]!.messages.at(-1)!.content, /cannot instantiate/);
});

test("gatekeeper refusal requests both updated plan and service blocks", async () => {
  const { result, requests } = await run([candidate([dispatch]), candidate([payment, confirm, dispatch])]);
  assert.equal(result.finalVerdict, "CONSTITUTIONAL_ACCEPTED");
  assert.match(requests[1]!.messages.at(-1)!.content, /updated JSON plan[\s\S]*TypeScript code/);
});
