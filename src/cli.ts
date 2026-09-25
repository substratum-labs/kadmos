import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { inferBoundary } from "./boundary_inference.js";
import { formatDilemmas, synthesizeDilemmas } from "./dilemma_synthesis.js";
import { compileWorldSpec, parseWorldSpec } from "./world_compiler.js";

function usage(): never {
  throw new Error("Usage: kadmos infer <file> | legislate <file> | compile <world-file> --out <dir>");
}

export function runCli(args: readonly string[]): string {
  const [command, file] = args;
  if (!file) usage();
  const source = readFileSync(file, "utf8");
  if (command === "infer" || command === "legislate") {
    if (args.length !== 2) usage();
    const inference = inferBoundary(source, { name: basename(file).replace(/\.[^.]+$/, "") });
    if (command === "legislate") return formatDilemmas(synthesizeDilemmas(inference));
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
