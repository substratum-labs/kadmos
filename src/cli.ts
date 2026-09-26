import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { inferBoundary, serializeWorldSpec } from "./boundary_inference.js";
import { formatDilemmas, synthesizeDilemmas } from "./dilemma_synthesis.js";
import { runLegislationWizard } from "./tui/wizard.js";
import { compileWorldSpec, parseWorldSpec } from "./world_compiler.js";
import { buildInitialPrompt, runKadmosAgent } from "./agent/runner.js";
import { createLlmProvider } from "./agent/provider.js";

function usage(): never {
  throw new Error("Usage: kadmos infer <file> | legislate <file> [--interactive|--accept-all-a|--accept-all-b] [--non-interactive] [--out <path>] | compile <world-file> --out <dir> | run --prd <file> --world <file> [--out <dir>] [--model <model>] [--provider <provider>] [--max-turns <N>] [--dry-run]");
}

export function runCli(args: readonly string[]): string | Promise<string> {
  if (args[0] === "run") {
    const values = new Map<string, string>();
    let dryRun = false;
    for (let i = 1; i < args.length; i++) {
      const flag = args[i]!;
      if (flag === "--dry-run") { if (dryRun) usage(); dryRun = true; continue; }
      if (!["--prd", "--world", "--out", "--model", "--provider", "--max-turns"].includes(flag) || values.has(flag) || !args[i + 1] || args[i + 1]!.startsWith("--")) usage();
      values.set(flag, args[++i]!);
    }
    const prdPath = values.get("--prd");
    const worldSpecPath = values.get("--world");
    if (!prdPath || !worldSpecPath) usage();
    const maxRepairTurns = values.has("--max-turns") ? Number(values.get("--max-turns")) : 3;
    if (!Number.isSafeInteger(maxRepairTurns) || maxRepairTurns < 1) usage();
    const worldSpec = parseWorldSpec(readFileSync(worldSpecPath, "utf8"));
    const prdContent = readFileSync(prdPath, "utf8");
    if (dryRun) return buildInitialPrompt(prdContent, worldSpec, compileWorldSpec(worldSpec).portsDts);
    const model = values.get("--model") ?? process.env.KADMOS_MODEL;
    const provider = createLlmProvider(values.get("--provider") ?? "openai", model ? { model } : {});
    return runKadmosAgent({ prdPath, worldSpecPath, outDir: values.get("--out") ?? "./dist/fabric", provider, maxRepairTurns })
      .then((result) => `${JSON.stringify(result, null, 2)}\n`);
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
        const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
        const yaml = serializeWorldSpec(worldSpec);
        parseWorldSpec(yaml);
        try {
          writeFileSync(temporary, yaml, { flag: "wx" });
          renameSync(temporary, destination);
        } catch (error) {
          try { unlinkSync(temporary); } catch { /* no temporary file was created */ }
          throw error;
        }
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
    if (args.length !== 4 || args[2] !== "--out" || !args[3]) usage();
    const spec = parseWorldSpec(source);
    const projection = compileWorldSpec(spec);
    mkdirSync(args[3], { recursive: true });
    writeFileSync(join(args[3], "ports.d.ts"), projection.portsDts);
    writeFileSync(join(args[3], "world_checker.ts"), projection.worldCheckerTs);
    return `Compiled ${spec.name} to ${args[3]}\n`;
  }
  usage();
}
