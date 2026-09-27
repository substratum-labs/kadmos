import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("MIT license names Substratum Labs", () => {
  const license = read("LICENSE");
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Substratum Labs \(https:\/\/github\.com\/substratum-labs\)/);
});

test("CI parses as YAML and covers the requested OS, Node, and Python matrix", () => {
  const workflow = parse(read(".github/workflows/ci.yml")) as Record<string, any>;
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  const matrix = workflow.jobs.test.strategy.matrix;
  assert.deepEqual(matrix.os, ["ubuntu-latest", "macos-latest"]);
  assert.deepEqual(matrix.node, [18, 20, 22]);
  assert.deepEqual(matrix.python, ["3.10", "3.11", "3.12", "3.13"]);
  const steps = workflow.jobs.test.steps.map((step: any) => step.uses ?? step.run);
  for (const command of ["pnpm install", "pnpm run typecheck", "pnpm test", "node bin/kadmos.js test conformance/fixtures/order_settlement.world.yaml --runs 30"]) {
    assert.ok(steps.some((step: string) => step.includes(command)), command);
  }
});

test("package metadata and publishing scripts are present", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.name, "kadmos");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.repository.url, "https://github.com/substratum-labs/kadmos.git");
  assert.deepEqual(manifest.bin, { kadmos: "./bin/kadmos.js", "kadmos-mcp": "./bin/kadmos-mcp.js" });
  assert.deepEqual(manifest.files, ["bin", "dist", "README.md", "LICENSE"]);
  for (const script of ["build", "typecheck", "test", "test:fuzz", "prepack"]) {
    assert.equal(typeof manifest.scripts[script], "string", script);
  }
  assert.match(manifest.engines.node, /18/);
  assert.match(manifest.packageManager, /^pnpm@10\./);
});

test("README explains all commands and contains parseable MCP configuration", () => {
  const readme = read("README.md");
  for (const command of ["infer", "legislate", "compile", "run", "mcp", "test", "graph", "init"]) {
    assert.match(readme, new RegExp(`kadmos ${command}\\b`), command);
  }
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.ok(blocks.some(([, content]) => {
    try {
      const config = JSON.parse(content!);
      return config.mcpServers?.kadmos?.command === "npx";
    } catch { return false; }
  }), "MCP JSON configuration");
});
