import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  assert.deepEqual(matrix.os, ["ubuntu-latest", "macos-latest", "windows-latest"]);
  assert.deepEqual(matrix.node, [20, 22]);
  assert.deepEqual(matrix.python, ["3.10", "3.11", "3.12", "3.13"]);
  const steps = workflow.jobs.test.steps.map((step: any) => step.uses ?? step.run);
  for (const command of ["pnpm install", "pnpm run typecheck", "pnpm test", "node bin/kadmos.js test conformance/fixtures/order_settlement.world.yaml --runs 30"]) {
    assert.ok(steps.some((step: string) => step.includes(command)), command);
  }
});

test("publish workflow verifies on a supported Node version", () => {
  const workflow = parse(read(".github/workflows/publish.yml")) as Record<string, any>;
  const setupNode = workflow.jobs.publish.steps.find((step: any) => step.uses?.startsWith("actions/setup-node@"));
  assert.ok([20, 22].includes(setupNode?.with?.["node-version"]));
});

test("package metadata and publishing scripts are present", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal(manifest.name, "@substratum-labs/kadmos");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.publishConfig, { access: "public" });
  assert.equal(manifest.repository.url, "https://github.com/substratum-labs/kadmos.git");
  assert.equal(manifest.homepage, "https://github.com/substratum-labs/kadmos#readme");
  assert.deepEqual(manifest.bugs, { url: "https://github.com/substratum-labs/kadmos/issues" });
  assert.equal(manifest.author, "Substratum Labs");
  assert.deepEqual(manifest.bin, { kadmos: "./bin/kadmos.js", "kadmos-mcp": "./bin/kadmos-mcp.js" });
  assert.deepEqual(manifest.files, ["bin", "dist/src", "skills", "README.md", "LICENSE"]);
  assert.deepEqual(manifest.exports["./adapters/bullmq"], {
    types: "./dist/src/adapters/bullmq/index.d.ts",
    default: "./dist/src/adapters/bullmq/index.js",
  });
  for (const script of ["build", "typecheck", "test", "test:fuzz", "prepack"]) {
    assert.equal(typeof manifest.scripts[script], "string", script);
  }
  assert.equal(manifest.engines.node, ">=20");
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
      return config.mcpServers?.kadmos?.command === "npx" &&
        config.mcpServers?.kadmos?.args?.includes("@substratum-labs/kadmos");
    } catch { return false; }
  }), "MCP JSON configuration");
});

test("packaged agent skill exists and is well-formed", () => {
  const skill = read("skills/kadmos/SKILL.md");
  assert.match(skill, /^---\nname:\s*kadmos\n/);
  assert.match(skill, /description:\s*Use when/);
  assert.match(skill, /# Kadmos: Evidence-Native Governed Coding/);
});

test("release hygiene: design artifacts and internal monorepo leaks are prevented", () => {
  assert.equal(existsSync(new URL("design", root)), false, "design directory must not exist");
  assert.equal(existsSync(new URL("GEMINI_SPECIFIC.md", root)), false, "GEMINI_SPECIFIC.md must not exist");
  assert.equal(existsSync(new URL(".editorconfig", root)), true, ".editorconfig must exist");
  assert.equal(existsSync(new URL(".gitattributes", root)), true, ".gitattributes must exist");

  const trackedOutput = execSync("git ls-files", { cwd: fileURLToPath(root), encoding: "utf8" });
  const files = trackedOutput.trim().split("\n").filter(Boolean);
  const targetForbidden = ["substratum", "internal"].join("-");
  for (const file of files) {
    if (file.endsWith("test_release_hygiene.test.ts")) continue;
    const fileUrl = new URL(file, root);
    if (existsSync(fileUrl)) {
      const content = readFileSync(fileUrl, "utf8");
      assert.ok(!content.includes(targetForbidden), `Tracked file ${file} contains reference to ${targetForbidden}`);
    }
  }
});

test("standalone agent instructions are present and self-contained", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /# Kadmos — Contributor & Coding Agent Instructions/);
  assert.match(agents, /pnpm run verify/);
  assert.ok(!agents.includes("substratum-internal"));

  assert.equal(existsSync(new URL("CLAUDE.md", root)), true, "CLAUDE.md must exist");
  assert.equal(existsSync(new URL("GEMINI.md", root)), true, "GEMINI.md must exist");
});
