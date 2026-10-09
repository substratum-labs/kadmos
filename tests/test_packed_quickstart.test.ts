import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.platform === "win32" ? "python" : "python3";
const pnpmCli = process.env.npm_execpath;

interface McpResponse {
  id: number;
  result: {
    protocolVersion?: string;
    tools?: Array<{ name: string }>;
    content?: Array<{ text: string }>;
  };
}

function run(command: string, args: string[], cwd: string, input?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  assert.equal(result.status, 0, `${JSON.stringify([command, ...args])}\n${result.error?.stack ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result.stdout;
}

function runPnpm(args: string[], cwd: string): string {
  assert.ok(pnpmCli, "run this probe from a pnpm lifecycle so npm_execpath identifies the pnpm JavaScript CLI");
  return run(process.execPath, [pnpmCli, ...args], cwd);
}

function listFiles(directory: string, relativePath = ""): string[] {
  return readdirSync(join(directory, relativePath), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(relativePath, entry.name);
    return entry.isDirectory() ? listFiles(directory, path) : [path];
  });
}

function checkLinks(source: string, content: string, files: Set<string>): void {
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const href = match[1]!;
    if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) continue;
    const target = decodeURIComponent(href.split(/[?#]/, 1)[0]!);
    const resolved = posix.normalize(posix.join(posix.dirname(source), target));
    assert.ok(!resolved.startsWith("../") && files.has(resolved), `${source} has unpacked relative link ${href}`);
  }
}

const world = {
  version: "kadmos.world.v0", name: "PackedMcp",
  states: [{ id: "START", initial: true }, { id: "DONE" }],
  context: { amount: { type: "integer", default: 5, min: 0, max: 10 } },
  invariants: [{ id: "BOUND", predicate: "amount >= 0" }],
  transitions: [{ id: "GO", from: "START", to: "DONE", guard: true, directive: null, effects: [] }],
};

test("packed source works in an isolated consumer, starter, and both MCP entry points", () => {
  const temp = mkdtempSync(join(tmpdir(), "kadmos packed start "));
  try {
    const packDir = join(temp, "pack");
    const consumer = join(temp, "consumer");
    const app = join(temp, "starter");
    mkdirSync(packDir);
    mkdirSync(consumer);
    runPnpm(["--config.ignore-scripts=true", "pack", "--pack-destination", packDir], root);
    const archives = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
    assert.equal(archives.length, 1, `expected one packed tarball: ${archives.join(", ")}`);
    const tarball = join(packDir, archives[0]!);
    const unpacked = join(temp, "unpacked");
    mkdirSync(unpacked);
    run("tar", ["-xzf", tarball, "-C", unpacked], root);
    const files = new Set(listFiles(join(unpacked, "package")));
    for (const required of ["README.md", "LICENSE", "skills/kadmos/SKILL.md", "bin/kadmos.js", "bin/kadmos-mcp.js", "dist/src/index.js"]) {
      assert.ok(files.has(required), `package must include ${required}`);
    }
    for (const file of files) assert.doesNotMatch(file, /^(?:tests|examples|docs|conformance)\//);
    checkLinks("README.md", readFileSync(join(unpacked, "package/README.md"), "utf8"), files);
    checkLinks("skills/kadmos/SKILL.md", readFileSync(join(unpacked, "package/skills/kadmos/SKILL.md"), "utf8"), files);

    const consumerTarball = `file:${relative(consumer, tarball).split(sep).join("/")}`;
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "kadmos-clean-consumer", private: true, type: "module", dependencies: { "@substratum-labs/kadmos": consumerTarball } }));
    runPnpm(["install", "--prefer-offline", "--ignore-scripts"], consumer);
    const packageRoot = join(consumer, "node_modules/@substratum-labs/kadmos");
    assert.ok(existsSync(join(packageRoot, "dist/src/index.js")));
    assert.ok(!realpathSync(packageRoot).startsWith(join(root, "node_modules")));
    const cli = join(packageRoot, "bin/kadmos.js");
    const mcp = join(packageRoot, "bin/kadmos-mcp.js");
    assert.match(run(process.execPath, [cli, "demo"], consumer), /GATEKEEPER REFUSED/);
    run(process.execPath, [cli, "init", app, "--lang", "all"], consumer);
    const manifestPath = join(app, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies: Record<string, string> };
    // The public starter uses "latest"; this unreleased probe resolves only the local tarball.
    manifest.dependencies["@substratum-labs/kadmos"] = `file:${relative(app, tarball).split(sep).join("/")}`;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    runPnpm(["install", "--prefer-offline", "--ignore-scripts"], app);
    runPnpm(["run", "compile"], app);
    assert.match(runPnpm(["test"], app), /0 divergences/);
    runPnpm(["run", "test:worker"], app);
    assert.equal(run(process.execPath, ["--input-type=module", "-e", "import('./dist/src/worker.js').then(m => console.log(m.runWorker().currentState))"], app).trim(), "PAYMENT_PENDING");
    run(python, ["-m", "unittest", "discover", "-s", "tests"], app);
    assert.equal(run(python, ["-B", "-c", "from src.worker import run_worker; print(run_worker()['currentState'])"], app).trim(), "PAYMENT_PENDING");

    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "packed-probe", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kadmos_step", arguments: { world, transitionId: "GO" } } },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";
    for (const args of [[cli, "mcp"], [mcp]]) {
      const output = run(process.execPath, args, consumer, messages);
      const responses = output.trim().split("\n").map((line) => JSON.parse(line) as McpResponse);
      assert.deepEqual(responses.map((response) => response.id), [1, 2, 3]);
      assert.ok(responses[0] && responses[1] && responses[2]);
      assert.equal(responses[0].result.protocolVersion, "2024-11-05");
      const tools = responses[1].result.tools;
      assert.ok(tools);
      assert.deepEqual(tools.map((tool) => tool.name), ["kadmos_infer", "kadmos_legislate", "kadmos_compile", "kadmos_step"]);
      const content = responses[2].result.content;
      assert.ok(content?.[0]);
      const verdict = JSON.parse(content[0].text) as { allowed: boolean; currentState: string };
      assert.equal(verdict.allowed, true);
      assert.equal(verdict.currentState, "DONE");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
