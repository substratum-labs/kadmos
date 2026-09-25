import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = join(process.cwd(), "bin", "kadmos.js");

test("infer and legislate print the candidate and a decision prompt", () => {
  const directory = mkdtempSync(join(tmpdir(), "kadmos-cli-"));
  try {
    const input = join(directory, "requirements.txt");
    writeFileSync(input, "Order status PAYMENT_PENDING can race with cancel and payment capture webhook. Escrow balance must stay nonnegative. Timeout on in-flight payment RPC may trigger retry.");
    const infer = spawnSync(process.execPath, [cli, "infer", input], { encoding: "utf8" });
    assert.equal(infer.status, 0, infer.stderr);
    assert.match(infer.stdout, /Candidate World/);
    assert.match(infer.stdout, /world\.spec\.yaml/);
    assert.match(infer.stdout, /escrow_balance/);
    const legislate = spawnSync(process.execPath, [cli, "legislate", input], { encoding: "utf8" });
    assert.equal(legislate.status, 0, legislate.stderr);
    assert.match(legislate.stdout, /Worst-Case Trace/);
    assert.match(legislate.stdout, /Option A/);
    assert.match(legislate.stdout, /Option B/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("compile writes the two usable projections", () => {
  const directory = mkdtempSync(join(tmpdir(), "kadmos-cli-"));
  try {
    const input = join(process.cwd(), "conformance", "fixtures", "order_settlement.world.yaml");
    const out = join(directory, "generated");
    const result = spawnSync(process.execPath, [cli, "compile", input, "--out", out], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(out, "ports.d.ts"), "utf8"), /IWorldChecker/);
    assert.match(readFileSync(join(out, "world_checker.ts"), "utf8"), /class WorldChecker/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
