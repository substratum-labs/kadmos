export type AssuranceAxisId = "code" | "agent";
export type OptionalIntegration = "pi" | "castor" | "roche";

export interface AssuranceAxis {
  readonly id: AssuranceAxisId;
  readonly question: string;
}

export interface ProjectIdentity {
  readonly name: "Kadmos";
  readonly purpose: string;
  readonly assuranceAxes: readonly AssuranceAxis[];
  readonly optionalIntegrations: readonly OptionalIntegration[];
}

export const projectIdentity = {
  name: "Kadmos",
  purpose: "Evidence-native coding agent",
  assuranceAxes: [
    {
      id: "code",
      question: "Does the artifact satisfy its declared contract?",
    },
    {
      id: "agent",
      question: "Did the agent remain within its granted authority?",
    },
  ],
  optionalIntegrations: ["pi", "castor", "roche"],
} as const satisfies ProjectIdentity;

export type * from "./types/world.js";
export type * from "./types/ports.js";
export type * from "./types/counterexample.js";
export { createWorldChecker } from "./world_checker.js";
export { runMcpServer } from "./mcp/server.js";
export { parseWorldSpec, compileWorldSpec, type WorldProjection } from "./world_compiler.js";
export { compileWorldSpecPython, type PythonWorldProjection } from "./python_compiler.js";
export { inferBoundary, type BoundaryCategory, type BoundaryCandidate, type BoundaryInferenceResult, type BoundaryInferenceOptions, type SemanticWorldExtraction } from "./boundary_inference.js";
export { synthesizeDilemmas, formatDilemmas, applyLegislationPatch, type LegislativeDilemma, type WorldPatch } from "./dilemma_synthesis.js";
export { runLegislationWizard, type LegislationWizardOptions, type LegislationResult } from "./tui/wizard.js";
export type * from "./agent/provider.js";
export { MockDeterministicProvider } from "./agent/provider.js";
export { synthesizeCegisPrompt } from "./agent/cegis_prompt.js";
export { OpenAiCompatibleProvider, AnthropicProvider, OllamaProvider, createLlmProvider } from "./agent/provider.js";
export type { ProviderOptions } from "./agent/provider.js";
export { buildInitialPrompt, runKadmosAgent } from "./agent/runner.js";
export type { AgentRunOptions, AgentRunResult } from "./agent/runner.js";
