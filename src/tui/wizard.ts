import { emitKeypressEvents } from "node:readline";
import type { LegislativeDilemma } from "../dilemma_synthesis.js";
import { applyLegislationPatch } from "../dilemma_synthesis.js";
import type { WorldSpec } from "../types/world.js";

export interface LegislationWizardOptions {
  readonly worldSpec: WorldSpec;
  readonly dilemmas: readonly LegislativeDilemma[];
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly acceptAllA?: boolean;
  readonly acceptAllB?: boolean;
  readonly nonInteractive?: boolean;
}

export interface LegislationResult {
  readonly worldSpec: WorldSpec;
  readonly decisions: readonly { readonly dilemmaId: string; readonly choice: "A" | "B" }[];
}

type TtyInput = NodeJS.ReadableStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (value: boolean) => void };

function ttyText(value: string): string {
  return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
}

export async function runLegislationWizard(options: LegislationWizardOptions): Promise<LegislationResult> {
  const { dilemmas } = options;
  if (!dilemmas.length) return { worldSpec: options.worldSpec, decisions: [] };
  if (options.acceptAllA && options.acceptAllB) throw new Error("Choose only one of --accept-all-a and --accept-all-b.");
  if (options.acceptAllA) {
    let worldSpec = options.worldSpec;
    for (const dilemma of dilemmas) worldSpec = applyLegislationPatch(worldSpec, dilemma.optionA.patch);
    return { worldSpec, decisions: dilemmas.map((dilemma) => ({ dilemmaId: dilemma.id, choice: "A" })) };
  }
  if (options.acceptAllB) return { worldSpec: options.worldSpec, decisions: dilemmas.map((dilemma) => ({ dilemmaId: dilemma.id, choice: "B" })) };

  const input = (options.input ?? process.stdin) as TtyInput;
  const output = options.output ?? process.stdout;
  if (options.nonInteractive || !input.isTTY || !input.setRawMode) throw new Error("Cannot prompt for legislative choices in non-interactive mode. Specify --accept-all-a or --accept-all-b.");

  const originalRaw = input.isRaw === true;
  const decisions: { dilemmaId: string; choice: "A" | "B" }[] = [];
  let worldSpec = options.worldSpec;
  let index = 0;
  let selected: "A" | "B" = "A";
  const render = () => {
    const dilemma = dilemmas[index]!;
    output.write(`\x1b[2J\x1b[H\x1b[36mKadmos Legislation\x1b[0m  ${ttyText(options.worldSpec.name)}  (${index + 1}/${dilemmas.length})\n`);
    output.write(`States: ${worldSpec.states.map((state) => ttyText(state.id)).join(", ")}\n\n\x1b[33m${ttyText(dilemma.id)}: ${ttyText(dilemma.title)}\x1b[0m\n`);
    for (const [step, trace] of dilemma.worstCaseTrace.entries()) output.write(`  ${step + 1}. ${ttyText(trace)}\n`);
    output.write(`\n${selected === "A" ? "\x1b[32m❯" : " "} [1] Option A — World law: ${ttyText(dilemma.optionA.description)}${selected === "A" ? "\x1b[0m" : ""}\n`);
    output.write(`${selected === "B" ? "\x1b[32m❯" : " "} [2] Option B — Fabric policy: ${ttyText(dilemma.optionB.description)}${selected === "B" ? "\x1b[0m" : ""}\n`);
    output.write("\n↑/↓ or 1/2 or A/B to select · Enter to confirm · q to abort\n");
  };

  let cleanup = () => {};
  try {
    emitKeypressEvents(input);
    input.setRawMode(true);
    return await new Promise<LegislationResult>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      const onEnd = () => fail(new Error("Legislation wizard aborted: input closed."));
      const onError = (error: Error) => fail(error);
      const onKeypress = (character: string | undefined, key: { name?: string; ctrl?: boolean } = {}) => {
        try {
          if (character === "q" || key.ctrl && key.name === "c") { fail(new Error("Legislation wizard aborted.")); return; }
          if (key.name === "up" || key.name === "down") selected = selected === "A" ? "B" : "A";
          else if (character === "1" || character?.toLowerCase() === "a") selected = "A";
          else if (character === "2" || character?.toLowerCase() === "b") selected = "B";
          else if (key.name === "return" || key.name === "enter") {
            const dilemma = dilemmas[index]!;
            if (selected === "A") worldSpec = applyLegislationPatch(worldSpec, dilemma.optionA.patch);
            decisions.push({ dilemmaId: dilemma.id, choice: selected });
            index++;
            if (index === dilemmas.length) { resolve({ worldSpec, decisions }); return; }
            selected = "A";
          }
          render();
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      };
      input.on("keypress", onKeypress);
      input.on("end", onEnd);
      input.on("error", onError);
      cleanup = () => {
        input.off("keypress", onKeypress);
        input.off("end", onEnd);
        input.off("error", onError);
      };
      render();
    });
  } finally {
    try { cleanup(); } finally { input.setRawMode(originalRaw); }
  }
}
