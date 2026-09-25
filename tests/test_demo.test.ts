import assert from "node:assert/strict";
import test from "node:test";

import { runOrderFabricDemo } from "../examples/order_fabric_demo.js";

test("end-to-end order fabric walkthrough runs to completion and verifies invariants", () => {
  const success = runOrderFabricDemo();
  assert.equal(success, true);
});
