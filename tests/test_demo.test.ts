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
  assert.match(output, /USER INPUT -> MODEL -> FABRIC -> INTEGRATION/);
  assert.match(output, /\[ 1\. USER INPUT \]/);
  assert.match(output, /\[ 2\. THE MODEL \]/);
  assert.match(output, /\[ 3\. THE FABRIC \]/);
  assert.match(output, /\[ 4\. INTEGRATION \]/);
  assert.match(output, /GATEKEEPER REFUSED UNCONSTITUTIONAL ACTION/);
  assert.match(output, /Shortest Counterexample Trace/);
  assert.match(output, /CEGIS: Minimal Counterexample Trace Guided Agent Self-Repair/);
  assert.match(output, /THE KADMOS SHIFT/);

  const cliOutput = await runCli(["demo"]);
  assert.match(cliOutput, /THE KADMOS SHIFT/);
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

