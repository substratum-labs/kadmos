import assert from "node:assert/strict";
import test from "node:test";

import { runOrderFabricDemo } from "../examples/order_fabric_demo.js";
import { runDemo } from "../src/demo.js";
import { runCli } from "../src/cli.js";

test("end-to-end order fabric walkthrough runs to completion and verifies invariants", () => {
  const success = runOrderFabricDemo();
  assert.equal(success, true);
});

test("built-in self-contained runDemo executes and verifies all invariants", async () => {
  const output = runDemo();
  assert.match(output, /Kadmos World-Fabric Integration Walkthrough/);
  assert.match(output, /REFUSED UNCONSTITUTIONAL ACTION/);
  assert.match(output, /Shortest Counterexample Trace/);
  assert.match(output, /Fail-closed verified/);
  assert.match(output, /Refusal-Guided Plan Repair/);
  assert.match(output, /Walkthrough Verdict: SUCCESS/);

  const cliOutput = await runCli(["demo"]);
  assert.match(cliOutput, /Walkthrough Verdict: SUCCESS/);
});

test("CLI with no arguments or --help outputs friendly banner and quickstart", async () => {
  const noArgs = await runCli([]);
  assert.match(noArgs, /Evidence-native architecture for coding agents/);
  assert.match(noArgs, /kadmos demo/);
  assert.match(noArgs, /npx @substratum-labs\/kadmos demo/);

  const helpFlag = await runCli(["--help"]);
  assert.equal(helpFlag, noArgs);

  const hFlag = await runCli(["-h"]);
  assert.equal(hFlag, noArgs);
});

