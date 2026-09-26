export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface LlmCompletionRequest {
  readonly systemPrompt: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: "text" | "json_object";
  readonly seed?: number;
}

export interface LlmUsageMetrics {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd?: number;
}

export interface LlmCompletionResponse {
  readonly content: string;
  readonly model: string;
  readonly usage?: LlmUsageMetrics;
  readonly latencyMs: number;
}

export interface ILlmProvider {
  readonly providerName: string;
  readonly defaultModel: string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

/** A finite, ordered script. Exhaustion fails closed instead of repeating a reply. */
export class MockDeterministicProvider implements ILlmProvider {
  readonly providerName = "mock";
  readonly defaultModel: string;
  private nextTurn = 0;

  constructor(
    private readonly responses: readonly (string | LlmCompletionResponse)[],
    model = "mock-deterministic",
  ) {
    this.defaultModel = model;
  }

  async complete(_request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (this.nextTurn >= this.responses.length) throw new Error("MockDeterministicProvider script exhausted");
    const scripted = this.responses[this.nextTurn++]!;
    return typeof scripted === "string"
      ? { content: scripted, model: this.defaultModel, latencyMs: 0 }
      : scripted;
  }
}
