import assert from "node:assert/strict";
import test from "node:test";

import { projectIdentity } from "../src/index.js";

test("declares code and agent as separate assurance axes", () => {
  assert.deepEqual(
    projectIdentity.assuranceAxes.map((axis) => axis.id),
    ["code", "agent"],
  );
});

test("keeps Pi, Castor, and Roche optional", () => {
  assert.deepEqual(projectIdentity.optionalIntegrations, [
    "pi",
    "castor",
    "roche",
  ]);
});
