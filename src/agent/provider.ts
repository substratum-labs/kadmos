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

export interface ProviderOptions {
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly responses?: readonly (string | LlmCompletionResponse)[];
}

function requireKey(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(`LLM_HTTP_${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LLM_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

function usage(value: unknown, promptKey: string, completionKey: string): LlmUsageMetrics | undefined {
  if (value === undefined) return undefined;
  const raw = record(value);
  const promptTokens = raw[promptKey];
  const completionTokens = raw[completionKey];
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return undefined;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

export class OpenAiCompatibleProvider implements ILlmProvider {
  readonly providerName = "openai";
  readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.defaultModel = options.model ?? process.env.KADMOS_MODEL ?? "gpt-6-sol";
    const base = (options.baseUrl ?? process.env.KADMOS_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.baseUrl = base.endsWith("/v1") ? base : `${base}/v1`;
    this.apiKey = options.apiKey ?? process.env.KADMOS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const started = Date.now();
    const raw = record(await postJson(`${this.baseUrl}/chat/completions`, {
      authorization: `Bearer ${requireKey(this.apiKey, "KADMOS_OPENAI_API_KEY or OPENAI_API_KEY")}`,
    }, {
      model: this.defaultModel,
      messages: [{ role: "system", content: request.systemPrompt }, ...request.messages],
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...(request.responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {}),
    }));
    const choice = record((raw.choices as unknown[])?.[0]);
    const content = record(choice.message).content;
    if (typeof content !== "string") throw new Error("LLM_RESPONSE_INVALID: content");
    const metrics = usage(raw.usage, "prompt_tokens", "completion_tokens");
    return { content, model: typeof raw.model === "string" ? raw.model : this.defaultModel, latencyMs: Date.now() - started, ...(metrics ? { usage: metrics } : {}) };
  }
}

export class AnthropicProvider implements ILlmProvider {
  readonly providerName = "anthropic";
  readonly defaultModel: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(options: ProviderOptions = {}) {
    this.defaultModel = options.model ?? process.env.KADMOS_MODEL ?? "claude-sonnet-4-5";
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const started = Date.now();
    const raw = record(await postJson(`${this.baseUrl}/messages`, {
      "x-api-key": requireKey(this.apiKey, "ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
    }, {
      model: this.defaultModel,
      system: request.systemPrompt,
      messages: request.messages.filter((message) => message.role !== "system"),
      max_tokens: request.maxTokens ?? 4096,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    }));
    const blocks = raw.content;
    if (!Array.isArray(blocks)) throw new Error("LLM_RESPONSE_INVALID: content");
    const content = blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
    if (!content) throw new Error("LLM_RESPONSE_INVALID: content");
    const metrics = usage(raw.usage, "input_tokens", "output_tokens");
    return { content, model: typeof raw.model === "string" ? raw.model : this.defaultModel, latencyMs: Date.now() - started, ...(metrics ? { usage: metrics } : {}) };
  }
}

export class OllamaProvider implements ILlmProvider {
  readonly providerName = "ollama";
  readonly defaultModel: string;
  private readonly host: string;

  constructor(options: ProviderOptions = {}) {
    this.defaultModel = options.model ?? process.env.KADMOS_MODEL ?? "qwen2.5-coder:32b";
    this.host = (options.baseUrl ?? process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/$/, "");
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const started = Date.now();
    const raw = record(await postJson(`${this.host}/api/chat`, {}, {
      model: this.defaultModel,
      stream: false,
      messages: [{ role: "system", content: request.systemPrompt }, ...request.messages],
      options: {
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
        ...(request.seed === undefined ? {} : { seed: request.seed }),
      },
      ...(request.responseFormat === "json_object" ? { format: "json" } : {}),
    }));
    const content = record(raw.message).content;
    if (typeof content !== "string") throw new Error("LLM_RESPONSE_INVALID: content");
    const metrics = usage(raw, "prompt_eval_count", "eval_count");
    return { content, model: typeof raw.model === "string" ? raw.model : this.defaultModel, latencyMs: Date.now() - started, ...(metrics ? { usage: metrics } : {}) };
  }
}

export function createLlmProvider(type: string, options: ProviderOptions = {}): ILlmProvider {
  switch (type) {
    case "openai": return new OpenAiCompatibleProvider(options);
    case "anthropic": return new AnthropicProvider(options);
    case "ollama": return new OllamaProvider(options);
    case "mock": return new MockDeterministicProvider(options.responses ?? [], options.model);
    default: throw new Error(`Unknown LLM provider: ${type}`);
  }
}
