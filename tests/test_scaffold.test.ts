import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initKadmosProject } from "../src/scaffold.js";
import { parseWorldSpec } from "../src/world_compiler.js";
import { runDifferentialFuzzing } from "../src/fuzzer.js";

test("scaffold all languages builds executable gatekeepers and fuzzable World", async () => {
  const parent = mkdtempSync(join(tmpdir(), "kadmos-init-"));
  const dir = join(parent, "app");
  try {
    const result = await initKadmosProject(dir, { lang: "all" });
    assert.equal(result.directory, dir);
    for (const path of ["world.yaml", "src/world/ports.d.ts", "src/world/world_checker.ts", "src/world/ports.py", "src/world/world_checker.py", "src/worker.ts", "src/worker.py", "tests/test_gatekeeper.test.ts", "tests/test_gatekeeper.py", "package.json", ".gitignore", ".github/workflows/ci.yml", "README.md"]) assert.ok(existsSync(join(dir, path)), path);
    const pythonCommand = process.platform === "win32" ? "python" : "python3";
    assert.match(readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8"), new RegExp(`${pythonCommand} -m unittest`));
    assert.match(readFileSync(join(dir, "README.md"), "utf8"), new RegExp(`${pythonCommand} -m unittest`));
    const world = parseWorldSpec(readFileSync(join(dir, "world.yaml"), "utf8"));
    const report = await runDifferentialFuzzing(world, { runs: 3, stepsPerRun: 5, seed: 42 });
    assert.equal(report.passed, true, JSON.stringify(report.divergences));
    const py = spawnSync(process.platform === "win32" ? "python" : "python3", ["-m", "unittest", "discover", "-s", "tests"], { cwd: dir, encoding: "utf8" });
    assert.equal(py.status, 0, py.stderr);
    symlinkSync(join(process.cwd(), "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const compile = spawnSync(process.execPath, [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "-p", join(dir, "tsconfig.json")], { cwd: dir, encoding: "utf8" });
    assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
    const ts = spawnSync(process.execPath, ["--test", join(dir, "dist/tests/test_gatekeeper.test.js")], { cwd: dir, encoding: "utf8" });
    assert.equal(ts.status, 0, `${ts.stdout}\n${ts.stderr}`);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(manifest.scripts.graph, "kadmos graph world.yaml --format html --out state_machine.html");
    assert.equal(manifest.dependencies["@substratum-labs/kadmos"], "latest");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("CLI init honors template and language and refuses existing nonempty directories", () => {
  const parent = mkdtempSync(join(tmpdir(), "kadmos-init-cli-"));
  const dir = join(parent, "app");
  try {
    const cli = join(process.cwd(), "bin/kadmos.js");
    const first = spawnSync(process.execPath, [cli, "init", dir, "--template", "circuit-breaker", "--lang", "python"], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(parseWorldSpec(readFileSync(join(dir, "world.yaml"), "utf8")).name, "CircuitBreakerWorld");
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts.compile, "kadmos compile world.yaml --out src/world --lang python");
    assert.equal(existsSync(join(dir, "src/worker.ts")), false);
    assert.ok(existsSync(join(dir, "src/worker.py")));
    writeFileSync(join(dir, "sentinel"), "keep");
    const second = spawnSync(process.execPath, [cli, "init", dir], { encoding: "utf8" });
    assert.equal(second.status, 1);
    const forced = spawnSync(process.execPath, [cli, "init", dir, "--force", "--lang", "ts"], { encoding: "utf8" });
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(readFileSync(join(dir, "sentinel"), "utf8"), "keep");
    assert.ok(existsSync(join(dir, "src/worker.ts")));
    assert.equal(existsSync(join(dir, "src/worker.py")), false);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts.compile, "kadmos compile world.yaml --out src/world --lang ts");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("force replaces a linked src directory without touching its external target", async () => {
  const parent = mkdtempSync(join(tmpdir(), "kadmos-init-link-"));
  const app = join(parent, "app");
  const outside = join(parent, "outside");
  try {
    mkdirSync(app);
    mkdirSync(join(outside, "world"), { recursive: true });
    writeFileSync(join(outside, "world", "ports.py"), "outside sentinel");
    writeFileSync(join(outside, "sentinel"), "keep");
    symlinkSync(outside, join(app, "src"), "dir");
    await initKadmosProject(app, { force: true, lang: "ts" });
    assert.equal(lstatSync(join(app, "src")).isSymbolicLink(), false);
    assert.ok(existsSync(join(app, "src/world/ports.d.ts")));
    assert.equal(readFileSync(join(outside, "world", "ports.py"), "utf8"), "outside sentinel");
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
