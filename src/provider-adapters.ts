import { RemembraError } from "./errors.js";
import {
  providerFetch,
  type ProviderContext,
  type ProviderPolicy,
} from "./provider.js";

/** A vendor-neutral text completion boundary. */
export interface LlmAdapter {
  readonly id: string;
  complete(
    request: { system: string; user: string },
    context?: ProviderContext,
  ): Promise<string>;
}

/** A vendor-neutral embedding boundary. */
export interface EmbeddingAdapter {
  readonly id: string;
  embed(text: string, context?: ProviderContext): Promise<number[]>;
}

export interface LlmAdapterOptions extends ProviderContext {
  /** Stable provider label used in provenance and diagnostics. */
  id?: string;
  /** Exact chat-completions endpoint for OpenAI-compatible servers. */
  endpoint?: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
}

export interface EmbeddingAdapterOptions extends ProviderContext {
  id?: string;
  /** Exact embeddings endpoint for OpenAI-compatible servers. */
  endpoint?: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
}

function contextFor(base: ProviderContext, override?: ProviderContext): ProviderContext {
  return {
    signal: override?.signal ?? base.signal,
    fetchImpl: override?.fetchImpl ?? base.fetchImpl,
    policy: override?.policy ?? base.policy,
  };
}

function requireApiKey(
  explicit: string | undefined,
  envName: string,
  provider: string,
  legacyMessage = `${provider} requires ${envName}`,
): string {
  const key = explicit ?? process.env[envName];
  if (!key) throw new Error(legacyMessage);
  return key;
}

function ollamaHost(): string {
  return (process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/+$/, "");
}

export function createOpenAICompatibleLlmAdapter(
  options: LlmAdapterOptions = {},
): LlmAdapter {
  const id = options.id ?? "openai";
  return {
    id,
    async complete(request, context) {
      const key = requireApiKey(
        options.apiKey,
        "OPENAI_API_KEY",
        "OpenAI-compatible LLM",
        id === "openai" ? "REMEMBRA_LLM=openai requires OPENAI_API_KEY" : undefined,
      );
      const data = await providerFetch<{
        choices?: { message?: { content?: string } }[];
      }>(
        options.endpoint ?? "https://api.openai.com/v1/chat/completions",
        {
          ...contextFor(options, context),
          label: "llm",
          headers: { ...options.headers, authorization: `Bearer ${key}` },
          body: {
            model: options.model ?? process.env.REMEMBRA_LLM_MODEL ?? "gpt-4o-mini",
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
          },
        },
      );
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new RemembraError(
          "LLM_ERROR",
          "llm returned a malformed response (missing choices[0].message.content)",
        );
      }
      return content;
    },
  };
}

export function createAnthropicLlmAdapter(options: LlmAdapterOptions = {}): LlmAdapter {
  const id = options.id ?? "anthropic";
  return {
    id,
    async complete(request, context) {
      const key = requireApiKey(
        options.apiKey,
        "ANTHROPIC_API_KEY",
        "Anthropic LLM",
        id === "anthropic" ? "REMEMBRA_LLM=anthropic requires ANTHROPIC_API_KEY" : undefined,
      );
      const data = await providerFetch<{ content?: { text?: string }[] }>(
        options.endpoint ?? "https://api.anthropic.com/v1/messages",
        {
          ...contextFor(options, context),
          label: "llm",
          headers: {
            ...options.headers,
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body: {
            model: options.model ?? process.env.REMEMBRA_LLM_MODEL ?? "claude-haiku-4-5",
            max_tokens: 4096,
            system: request.system,
            messages: [{ role: "user", content: request.user }],
          },
        },
      );
      const content = data?.content?.[0]?.text;
      if (typeof content !== "string") {
        throw new RemembraError(
          "LLM_ERROR",
          "llm returned a malformed response (missing content[0].text)",
        );
      }
      return content;
    },
  };
}

export function createOllamaLlmAdapter(options: LlmAdapterOptions = {}): LlmAdapter {
  const id = options.id ?? "ollama";
  return {
    id,
    async complete(request, context) {
      const data = await providerFetch<{ message?: { content?: string } }>(
        options.endpoint ?? `${ollamaHost()}/api/chat`,
        {
          ...contextFor(options, context),
          label: "llm",
          headers: options.headers,
          body: {
            model: options.model ?? process.env.REMEMBRA_LLM_MODEL ?? "llama3.2",
            format: "json",
            stream: false,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
          },
        },
      );
      const content = data?.message?.content;
      if (typeof content !== "string") {
        throw new RemembraError(
          "LLM_ERROR",
          "llm returned a malformed response (missing message.content)",
        );
      }
      return content;
    },
  };
}

export type LlmProviderName = "openai" | "anthropic" | "ollama";

export function createLlmAdapter(
  provider: LlmProviderName,
  options: LlmAdapterOptions = {},
): LlmAdapter {
  switch (provider) {
    case "openai":
      return createOpenAICompatibleLlmAdapter(options);
    case "anthropic":
      return createAnthropicLlmAdapter(options);
    case "ollama":
      return createOllamaLlmAdapter(options);
  }
}

export function createInjectedLlmAdapter(
  id: string,
  complete: LlmAdapter["complete"],
): LlmAdapter {
  if (!id.trim()) throw new Error("Injected LLM adapter id must not be empty");
  return { id, complete };
}

export function createOpenAIEmbeddingAdapter(
  options: EmbeddingAdapterOptions = {},
): EmbeddingAdapter {
  const id = options.id ?? "openai";
  return {
    id,
    async embed(text, context) {
      const key = requireApiKey(
        options.apiKey,
        "OPENAI_API_KEY",
        "OpenAI embeddings",
        id === "openai" ? "REMEMBRA_EMBEDDINGS=openai requires OPENAI_API_KEY" : undefined,
      );
      const data = await providerFetch<{ data?: { embedding?: unknown }[] }>(
        options.endpoint ?? "https://api.openai.com/v1/embeddings",
        {
          ...contextFor(options, context),
          label: "embeddings",
          headers: { ...options.headers, authorization: `Bearer ${key}` },
          body: {
            model: options.model ?? process.env.REMEMBRA_EMBEDDING_MODEL ?? "text-embedding-3-small",
            input: text,
          },
        },
      );
      return validateEmbeddingVector(data?.data?.[0]?.embedding, id);
    },
  };
}

export function createOllamaEmbeddingAdapter(
  options: EmbeddingAdapterOptions = {},
): EmbeddingAdapter {
  const id = options.id ?? "ollama";
  return {
    id,
    async embed(text, context) {
      const data = await providerFetch<{ embedding?: unknown }>(
        options.endpoint ?? `${ollamaHost()}/api/embeddings`,
        {
          ...contextFor(options, context),
          label: "embeddings",
          headers: options.headers,
          body: {
            model: options.model ?? process.env.REMEMBRA_EMBEDDING_MODEL ?? "nomic-embed-text",
            prompt: text,
          },
        },
      );
      return validateEmbeddingVector(data.embedding, id);
    },
  };
}

export type EmbeddingProviderName = "openai" | "ollama";

export function createEmbeddingAdapter(
  provider: EmbeddingProviderName,
  options: EmbeddingAdapterOptions = {},
): EmbeddingAdapter {
  switch (provider) {
    case "openai":
      return createOpenAIEmbeddingAdapter(options);
    case "ollama":
      return createOllamaEmbeddingAdapter(options);
  }
}

export function createInjectedEmbeddingAdapter(
  id: string,
  embed: EmbeddingAdapter["embed"],
): EmbeddingAdapter {
  if (!id.trim()) throw new Error("Injected embedding adapter id must not be empty");
  return { id, embed };
}

export function validateEmbeddingVector(value: unknown, provider: string): number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((n): n is number => typeof n === "number" && Number.isFinite(n))
  ) {
    throw new RemembraError("LLM_ERROR", `${provider} returned a malformed embedding vector`);
  }
  return value;
}

export type { ProviderContext, ProviderPolicy };
