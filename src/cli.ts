import { cpSync, lstatSync, mkdtempSync, readFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { atomicWrite } from "./atomic_write.js";
import { inferBoundary, serializeWorldSpec } from "./boundary_inference.js";
import { formatDilemmas, synthesizeDilemmas } from "./dilemma_synthesis.js";
import { runLegislationWizard } from "./tui/wizard.js";
import { compileWorldSpec, compileWorldSpecPython, parseWorldSpec } from "./world_compiler.js";
import { buildInitialPrompt, runKadmosAgent } from "./agent/runner.js";
import { createLlmProvider } from "./agent/provider.js";
import { runMcpServer } from "./mcp/server.js";
import { runDifferentialFuzzing } from "./fuzzer.js";
import { renderWorldGraph } from "./visualizer.js";
import { initKadmosProject, type ScaffoldOptions } from "./scaffold.js";
import { runDemo } from "./demo.js";

function formatHelp(): string {
  const useColor = Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
  const color = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  const bold = (text: string) => color("1", text);
  const cyan = (text: string) => color("36", text);
  const dim = (text: string) => color("2", text);

  return `
${bold(cyan("  _  __          _                         "))}
${bold(cyan(" | |/ /__ _   __| |_ __  ___  ___          "))}
${bold(cyan(" | ' // _` | / _` | '  \\/ _ \\/ __|        "))}
${bold(cyan(" |_|\\_\\__,_| \\__,_|_|_|_\\___/\\___/         "))}
 ${dim("Evidence-native architecture for coding agents (v0.1.2)")}

${bold("Commands:")}
  ${cyan("demo")}                                Run 10-second interactive hallucination & repair walkthrough
  ${cyan("init")} [dir] [--template <tpl>]       Scaffold a new governed project
  ${cyan("compile")} <world.yaml> --out <dir>    Compile World model into TypeScript and Python seams
  ${cyan("test")} <world.yaml> [--runs <N>]      Compare sampled TypeScript and Python checker verdicts
  ${cyan("graph")} <world.yaml> [--format html]  Visualize state machine (Mermaid, Graphviz DOT, or HTML)
  ${cyan("mcp")}                                 Start stdio Model Context Protocol server for Cursor / Claude
  ${cyan("infer")} <file>                        Extract candidate World and Fabric boundaries from PRDs
  ${cyan("legislate")} <file> [--interactive]    Resolve state-machine dilemmas via terminal TUI wizard
  ${cyan("run")} --prd <file>                    Run bounded CEGIS agent self-repair loop

${bold("Quickstart:")}
  $ npx @substratum-labs/kadmos demo
  $ npx @substratum-labs/kadmos init my-agent && cd my-agent
  $ pnpm install && pnpm run compile && pnpm test
\n`;
}

function usage(): never {
  throw new Error("Usage: kadmos demo | mcp | graph <world-file> [--format mermaid|dot|html] [--out <file>] [--open] | init [directory] [--template default|order-settlement|circuit-breaker] [--lang ts|python|all] [--force] | test <world-file> [--runs <N>] [--steps <M>] [--seed <S>] [--coverage] [--json] | infer <file> | legislate <file> [--interactive] [--accept-all-a] [--accept-all-b] [--non-interactive] [--out <path>] | compile <world-file> --out <dir> [--lang ts|python|all] | run --prd <file> [--world <file>] [--world-out <path>] [--out <dir>] [--model <model>] [--provider <provider>] [--max-turns <N>] [--accept-all-a] [--accept-all-b] [--non-interactive] [--dry-run]");
}

function publishProjectionDirectory(outDir: string, files: Record<string, string>): void {
  outDir = resolve(outDir);
  for (let current = outDir; ; current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Cannot compile into symlinked path: ${current}`);
    }
    if (current === parse(current).root) break;
  }
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, `.${basename(outDir)}.compile-`));
  const staged = join(temporary, "staged");
  const previous = join(temporary, "previous");
  let movedPrevious = false;
  try {
    mkdirSync(staged);
    const stat = lstatSync(outDir, { throwIfNoEntry: false });
    if (stat && !stat.isSymbolicLink() && stat.isDirectory()) cpSync(outDir, staged, { recursive: true });
    const tsFiles = ["ports.d.ts", "world_checker.ts"];
    const pythonFiles = ["ports.py", "world_checker.py"];
    const obsolete = Object.keys(files).length === 4 ? [] : tsFiles.every((name) => name in files) ? pythonFiles : tsFiles;
    for (const name of obsolete) {
      const path = join(staged, name);
      if (lstatSync(path, { throwIfNoEntry: false })) rmSync(path);
    }
    for (const [name, content] of Object.entries(files)) {
      const path = join(staged, name);
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(path);
      writeFileSync(path, content);
    }
    if (stat) { renameSync(outDir, previous); movedPrevious = true; }
    try { renameSync(staged, outDir); }
    catch (error) {
      if (movedPrevious) renameSync(previous, outDir);
      throw error;
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function runCli(args: readonly string[]): string | Promise<string> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    return formatHelp();
  }
  if (args[0] === "demo") {
    if (args.length > 1) usage();
    return runDemo();
  }
  if (args[0] === "init") {
    let directory = ".";
    let index = 1;
    if (args[index] && !args[index]!.startsWith("--")) directory = args[index++]!;
    const options: { template?: NonNullable<ScaffoldOptions["template"]>; lang?: NonNullable<ScaffoldOptions["lang"]>; force?: boolean } = {};
    for (; index < args.length; index++) {
      const flag = args[index];
      if (flag === "--force" && !options.force) options.force = true;
      else if (flag === "--template" && !options.template && ["default", "order-settlement", "circuit-breaker"].includes(args[index + 1] ?? "")) options.template = args[++index] as NonNullable<ScaffoldOptions["template"]>;
      else if (flag === "--lang" && !options.lang && ["ts", "python", "all"].includes(args[index + 1] ?? "")) options.lang = args[++index] as NonNullable<ScaffoldOptions["lang"]>;
      else usage();
    }
    return initKadmosProject(directory, options).then((result) => `Initialized ${result.directory} (${result.files.length} files)\n`);
  }
  if (args[0] === "graph") {
    const file = args[1];
    if (!file || file.startsWith("--")) usage();
    let format: "mermaid" | "dot" | "html" = "mermaid";
    let seenFormat = false;
    let out: string | undefined;
    let open = false;
    for (let i = 2; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--format" && !seenFormat && ["mermaid", "dot", "html"].includes(args[i + 1] ?? "")) { format = args[++i] as "mermaid" | "dot" | "html"; seenFormat = true; }
      else if (flag === "--out" && !out && args[i + 1] && !args[i + 1]!.startsWith("--")) out = args[++i];
      else if (flag === "--open" && !open) open = true;
      else usage();
    }
    if (open && format !== "html") usage();
    const graph = renderWorldGraph(parseWorldSpec(readFileSync(file, "utf8")), format);
    if (!out && !open) return graph;
    const destination = resolve(out ?? join(mkdtempSync(join(tmpdir(), "kadmos-graph-")), "world.html"));
    atomicWrite(destination, graph);
    if (open) {
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const opener = spawnSync(command, process.platform === "win32" ? ["/c", "start", "", destination] : [destination], { encoding: "utf8" });
      if (opener.error || opener.status !== 0) throw new Error(`Could not open graph: ${opener.error?.message ?? opener.stderr}`);
    }
    return `Wrote ${destination}\n`;
  }
  if (args[0] === "test") {
    const file = args[1];
    if (!file || file.startsWith("--")) usage();
    const values = new Map<string, number>();
    const flags = new Set<string>();
    for (let i = 2; i < args.length; i++) {
      const flag = args[i]!;
      if (flag === "--coverage" || flag === "--json") {
        if (flags.has(flag)) usage();
        flags.add(flag);
      } else if (["--runs", "--steps", "--seed"].includes(flag)) {
        if (values.has(flag) || !args[i + 1]) usage();
        const value = Number(args[++i]);
        if (!Number.isSafeInteger(value) || flag !== "--seed" && value < 1) usage();
        values.set(flag, value);
      } else usage();
    }
    const spec = parseWorldSpec(readFileSync(file, "utf8"));
    const runs = values.get("--runs") ?? 50;
    const stepsPerRun = values.get("--steps") ?? 20;
    const seed = values.get("--seed") ?? Date.now();
    return runDifferentialFuzzing(spec, { runs, stepsPerRun, seed }).then((report) => {
      if (flags.has("--json")) return `${JSON.stringify(report, null, 2)}\n`;
      const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
      const lines = [
        "Kadmos Seeded Differential Check",
        `World: ${file} (${spec.states.length} states, ${spec.transitions.length} transitions)`,
        `Runs: ${runs} | Steps/Run: ${stepsPerRun} | Seed: ${seed}`,
        "Comparing sampled TypeScript interpreter and generated Python verdicts...",
        `Observed: ${runs} runs, ${report.totalSteps.toLocaleString("en-US")} sampled steps, ${report.divergences.length} divergences`,
        `Result: ${report.passed ? "sampled verdicts matched" : "sampled verdicts differed"}`,
      ];
      if (flags.has("--coverage")) lines.push("Coverage:", `  States: ${percent(report.stateCoverage.ratio)} (${report.stateCoverage.visited.length}/${report.stateCoverage.total.length})`, `  Transitions: ${percent(report.transitionCoverage.ratio)} (${report.transitionCoverage.visited.length}/${report.transitionCoverage.total.length})`);
      for (const divergence of report.divergences.slice(0, 5)) lines.push(`Run ${divergence.run}, step ${divergence.step}: ${divergence.reason}\n  Request: ${JSON.stringify(divergence.request)}\n  TS: ${JSON.stringify(divergence.tsVerdict)}\n  Python: ${JSON.stringify(divergence.pyVerdict)}`);
      return `${lines.join("\n")}\n`;
    });
  }
  if (args[0] === "mcp") {
    if (args.length !== 1) usage();
    runMcpServer();
    return "";
  }
  if (args[0] === "run") {
    const values = new Map<string, string>();
    const booleanFlags = new Set<string>();
    for (let i = 1; i < args.length; i++) {
      const flag = args[i]!;
      if (["--dry-run", "--accept-all-a", "--accept-all-b", "--non-interactive"].includes(flag)) {
        if (booleanFlags.has(flag)) usage();
        booleanFlags.add(flag);
        continue;
      }
      if (!["--prd", "--world", "--world-out", "--out", "--model", "--provider", "--max-turns"].includes(flag) || values.has(flag) || !args[i + 1] || args[i + 1]!.startsWith("--")) usage();
      values.set(flag, args[++i]!);
    }
    const prdPath = values.get("--prd");
    const worldSpecPath = values.get("--world");
    if (!prdPath || booleanFlags.has("--accept-all-a") && booleanFlags.has("--accept-all-b") || worldSpecPath && ["--accept-all-a", "--accept-all-b", "--non-interactive"].some((flag) => booleanFlags.has(flag))) usage();
    const maxRepairTurns = values.has("--max-turns") ? Number(values.get("--max-turns")) : 3;
    if (!Number.isSafeInteger(maxRepairTurns) || maxRepairTurns < 1) usage();
    const prdContent = readFileSync(prdPath, "utf8");
    const model = values.get("--model") ?? process.env.KADMOS_MODEL;
    const outDir = values.get("--out") ?? "./dist/fabric";
    if (worldSpecPath) {
      const worldSpec = parseWorldSpec(readFileSync(worldSpecPath, "utf8"));
      if (booleanFlags.has("--dry-run")) return buildInitialPrompt(prdContent, worldSpec, compileWorldSpec(worldSpec).portsDts);
      const provider = createLlmProvider(values.get("--provider") ?? "openai", model ? { model } : {});
      return runKadmosAgent({ prdPath, worldSpecPath, outDir, provider, maxRepairTurns })
        .then((result) => `${JSON.stringify(result, null, 2)}\n`);
    }
    const provider = createLlmProvider(values.get("--provider") ?? "openai", model ? { model } : {});
    return (async () => {
      const inference = await inferBoundary(prdContent, { name: basename(prdPath).replace(/\.[^.]+$/, ""), provider, ...(model ? { model } : {}) });
      const dilemmas = synthesizeDilemmas(inference);
      const { worldSpec: legislatedSpec, decisions } = await runLegislationWizard({
        worldSpec: inference.worldSpec,
        dilemmas,
        acceptAllA: booleanFlags.has("--accept-all-a"),
        acceptAllB: booleanFlags.has("--accept-all-b"),
        nonInteractive: booleanFlags.has("--non-interactive"),
      });
      const worldOut = values.get("--world-out") ?? join(outDir, "world.spec.yaml");
      const fabricGuidance = decisions.filter((decision) => decision.choice === "B").map((decision) => ({ dilemmaId: decision.dilemmaId, guidance: dilemmas.find((dilemma) => dilemma.id === decision.dilemmaId)!.optionB.fabricGuidance }));
      atomicWrite(worldOut, serializeWorldSpec(legislatedSpec));
      atomicWrite(join(dirname(worldOut), "decisions.json"), `${JSON.stringify(decisions, null, 2)}\n`);
      if (booleanFlags.has("--dry-run")) return buildInitialPrompt(prdContent, legislatedSpec, compileWorldSpec(legislatedSpec).portsDts, fabricGuidance);
      const result = await runKadmosAgent({ prdPath, worldSpec: legislatedSpec, worldSpecPath: worldOut, outDir, provider, maxRepairTurns, fabricGuidance });
      return `${JSON.stringify(result, null, 2)}\n`;
    })();
  }
  const [command, file] = args;
  if (!file) usage();
  const source = readFileSync(file, "utf8");
  if (command === "infer" || command === "legislate") {
    const inference = inferBoundary(source, { name: basename(file).replace(/\.[^.]+$/, "") });
    if (command === "legislate") {
      let interactive = false;
      let acceptAllA = false;
      let acceptAllB = false;
      let nonInteractive = false;
      let out: string | undefined;
      for (let i = 2; i < args.length; i++) {
        const flag = args[i];
        if (flag === "--interactive") { if (interactive) usage(); interactive = true; }
        else if (flag === "--accept-all-a") { if (acceptAllA) usage(); acceptAllA = true; }
        else if (flag === "--accept-all-b") { if (acceptAllB) usage(); acceptAllB = true; }
        else if (flag === "--non-interactive") { if (nonInteractive) usage(); nonInteractive = true; }
        else if (flag === "--out") { if (out || !args[i + 1] || args[i + 1]!.startsWith("--")) usage(); out = args[++i]; }
        else usage();
      }
      if (acceptAllA && acceptAllB || interactive && nonInteractive || interactive && (acceptAllA || acceptAllB)) usage();
      const dilemmas = synthesizeDilemmas(inference);
      if (!interactive && !acceptAllA && !acceptAllB && !nonInteractive) return formatDilemmas(dilemmas);
      return runLegislationWizard({ worldSpec: inference.worldSpec, dilemmas, acceptAllA, acceptAllB, nonInteractive }).then(({ worldSpec, decisions }) => {
        const destination = out ?? join(dirname(file), "world.spec.yaml");
        const yaml = serializeWorldSpec(worldSpec);
        parseWorldSpec(yaml);
        atomicWrite(destination, yaml);
        return `Wrote ${destination} after ${decisions.length} legislative decision(s).\n`;
      });
    }
    if (args.length !== 2) usage();
    const rows = ["Domain | Category | Evidence | Justification", "--- | --- | --- | ---"];
    for (const [domain, candidates] of [["Candidate World", inference.worldCandidates], ["Candidate Fabric", inference.fabricCandidates]] as const) {
      for (const candidate of candidates) rows.push(`${domain} | ${candidate.category} | ${candidate.evidence.replaceAll("|", "\\|")} | ${candidate.justification}`);
    }
    return `${rows.join("\n")}\n\n# Candidate world.spec.yaml\n${inference.worldYaml}`;
  }
  if (command === "compile") {
    if ((args.length !== 4 && args.length !== 6) || args[2] !== "--out" || !args[3] || (args.length === 6 && args[4] !== "--lang")) usage();
    const lang = args.length === 6 ? args[5] : "ts";
    if (lang !== "ts" && lang !== "python" && lang !== "all") usage();
    const spec = parseWorldSpec(source);
    const files: Record<string, string> = {};
    if (lang === "ts" || lang === "all") {
      const projection = compileWorldSpec(spec);
      files["ports.d.ts"] = projection.portsDts;
      files["world_checker.ts"] = projection.worldCheckerTs;
    }
    if (lang === "python" || lang === "all") {
      const projection = compileWorldSpecPython(spec);
      files["ports.py"] = projection.portsPy;
      files["world_checker.py"] = projection.worldCheckerPy;
    }
    publishProjectionDirectory(args[3], files);
    return `Compiled ${spec.name} to ${args[3]}\n`;
  }
  usage();
}
