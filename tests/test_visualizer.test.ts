import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseWorldSpec } from "../src/world_compiler.js";
import { renderWorldGraph } from "../src/visualizer.js";

const fixture = join(process.cwd(), "conformance/fixtures/order_settlement.world.yaml");
const spec = parseWorldSpec(readFileSync(fixture, "utf8"));

test("Mermaid renders entry, exits, guarded and directed transitions", () => {
  const graph = renderWorldGraph(spec, "mermaid");
  assert.match(graph, /^stateDiagram-v2\n/);
  assert.match(graph, /\[\*\] --> CREATED/);
  assert.match(graph, /FULFILLED --> \[\*\]/);
  assert.match(graph, /CANCELLED --> \[\*\]/);
  assert.match(graph, /CREATED --> PAYMENT_PENDING : INITIATE_PAYMENT \[order_amount > 0\] \/ DISPATCH_PAYMENT_GATEWAY/);
  assert.doesNotMatch(graph, /&gt;/);
  assert.match(graph, /state "Order registered in system, awaiting payment" as CREATED/);
});

test("DOT renders graph syntax and terminal shapes", () => {
  const graph = renderWorldGraph(spec, "dot");
  assert.match(graph, /^digraph World \{/);
  assert.match(graph, /rankdir=LR;/);
  assert.match(graph, /__start__ \[shape=none, label=""\];/);
  assert.match(graph, /"FULFILLED" \[shape=doublecircle/);
  assert.match(graph, /"PAID" -> "FULFILLED" \[label="DISPATCH_GOODS/);
});

test("HTML escapes untrusted text while retaining Mermaid module", () => {
  const hostile = { ...spec, name: '<script>alert("x")</script>', states: spec.states.map((s) => s.id === "CREATED" ? { ...s, description: '</pre><script>alert("x")</script>' } : s) };
  const html = renderWorldGraph(hostile, "html");
  assert.match(html, /<title>Kadmos World: &lt;script&gt;/);
  assert.match(html, /class="mermaid"/);
  assert.match(html, /mermaid@10\.9\.1\/dist\/mermaid.esm.min.mjs/);
  assert.match(html, /securityLevel: 'strict'/);
  assert.doesNotMatch(html, /<script>alert\("x"\)<\/script>/);
  assert.match(html, /5 states/);
  assert.match(html, /3 invariants/);
});

test("Mermaid quotes descriptions and backslashes without corrupting graph syntax", () => {
  const descriptionLine = (description: string) => renderWorldGraph({ ...spec, states: spec.states.map((state) => state.id === "CREATED" ? { ...state, description } : state) }, "mermaid");
  assert.ok(descriptionLine('foo"bar').includes('state "foo#quot;bar" as CREATED'));
  assert.ok(descriptionLine('foo\\bar').includes('state "foo\\bar" as CREATED'));
  assert.ok(descriptionLine('foo\\"bar').includes('state "foo\\#quot;bar" as CREATED'));
  const nonString = { ...spec, states: spec.states.map((state) => state.id === "CREATED" ? { ...state, description: 42 as unknown as string } : state) };
  assert.match(renderWorldGraph(nonString, "mermaid"), /state "42" as CREATED/);
  const zero = { ...spec, states: spec.states.map((state) => state.id === "CREATED" ? { ...state, description: 0 as unknown as string } : state) };
  assert.match(renderWorldGraph(zero, "mermaid"), /state "0" as CREATED/);
});

test("CLI graph writes selected format atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "kadmos-graph-"));
  try {
    const out = join(dir, "world.dot");
    const result = spawnSync(process.execPath, [join(process.cwd(), "bin/kadmos.js"), "graph", fixture, "--format", "dot", "--out", out], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(out, "utf8"), /^digraph World \{/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
