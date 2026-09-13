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
