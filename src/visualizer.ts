import type { WorldSpec } from "./types/world.js";

function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function mermaidText(value: string): string {
  return htmlEscape(value.replace(/\r\n?|\n/g, " ")).replace(/[`{}|]/g, (character) => `&#${character.charCodeAt(0)};`);
}

function edgeLabel(transition: WorldSpec["transitions"][number]): string {
  const guard = transition.guard !== true && transition.guard !== "true" ? ` [${String(transition.guard)}]` : "";
  return `${transition.id}${guard}${transition.directive ? ` / ${transition.directive}` : ""}`;
}

function mermaid(spec: WorldSpec): string {
  const aliases = new Map(spec.states.map((state, index) => [state.id, /^[A-Za-z_][A-Za-z_0-9]*$/.test(state.id) && state.id !== "__start__" ? state.id : `state_${index}`]));
  const lines = ["stateDiagram-v2"];
  for (const state of spec.states) {
    const alias = aliases.get(state.id)!;
    if (state.description || alias !== state.id) lines.push(`    state "${mermaidText(state.description ?? state.id)}" as ${alias}`);
  }
  const initial = spec.states.find((state) => state.initial);
  if (initial) lines.push(`    [*] --> ${aliases.get(initial.id)}`);
  for (const transition of spec.transitions) lines.push(`    ${aliases.get(transition.from)} --> ${aliases.get(transition.to)} : ${mermaidText(edgeLabel(transition))}`);
  for (const state of spec.states) if (state.terminal) lines.push(`    ${aliases.get(state.id)} --> [*]`);
  return `${lines.join("\n")}\n`;
}

function dot(spec: WorldSpec): string {
  const lines = ["digraph World {", "  rankdir=LR;", '  __start__ [shape=none, label=""];'];
  for (const state of spec.states) lines.push(`  ${JSON.stringify(state.id)} [shape=${state.terminal ? "doublecircle" : "ellipse"}, label=${JSON.stringify(state.description ? `${state.id}\n${state.description}` : state.id)}];`);
  const initial = spec.states.find((state) => state.initial);
  if (initial) lines.push(`  __start__ -> ${JSON.stringify(initial.id)};`);
  for (const transition of spec.transitions) lines.push(`  ${JSON.stringify(transition.from)} -> ${JSON.stringify(transition.to)} [label=${JSON.stringify(edgeLabel(transition))}];`);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function html(spec: WorldSpec): string {
  const invariants = spec.invariants.map((invariant) => `<li><strong>${htmlEscape(invariant.id)}</strong>: ${htmlEscape(invariant.description ?? invariant.predicate)}</li>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kadmos World: ${htmlEscape(spec.name)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 1100px; margin: 0 auto; padding: 2rem; line-height: 1.5; background: Canvas; color: CanvasText; }
    header, section { border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; }
    h1 { margin-top: 0; } .stats { font-weight: 600; } .mermaid { overflow-x: auto; }
  </style>
</head>
<body>
  <header><h1>${htmlEscape(spec.name)}</h1><p class="stats">${spec.states.length} states · ${spec.transitions.length} transitions · ${spec.invariants.length} invariants</p></header>
  <section><pre class="mermaid">${htmlEscape(mermaid(spec))}</pre></section>
  <section><h2>Declared invariants</h2><ul>${invariants}</ul></section>
  <script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs'; mermaid.initialize({ startOnLoad: true, theme: 'neutral' });</script>
</body>
</html>
`;
}

export function renderWorldGraph(spec: WorldSpec, format: "mermaid" | "dot" | "html"): string {
  switch (format) {
    case "mermaid": return mermaid(spec);
    case "dot": return dot(spec);
    case "html": return html(spec);
    default: throw new Error(`Unsupported graph format: ${String(format)}`);
  }
}
