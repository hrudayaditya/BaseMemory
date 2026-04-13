import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_MODELS } from "../src/config/constants.js";
import { createCustomProviderInfo, type ConfiguredProviderInfo } from "../src/embeddings/detector.js";
import {
  createEmbeddingProvider,
  EmbeddingTransientError,
  EmbeddingValidationError,
  VoyageEmbeddingProvider,
} from "../src/embeddings/provider.js";

type ProviderInstance = ReturnType<typeof createEmbeddingProvider> | VoyageEmbeddingProvider;

interface ProviderCase {
  name: string;
  dimensions: number;
  createProvider(): ProviderInstance;
  createSuccessResponse(count: number, dimensions?: number): Response;
  createMalformedResponse(): Response;
  createWrongDimensionResponse(): Response;
}

function createOpenAICompatibleResponse(count: number, dimensions: number): Response {
  return new Response(JSON.stringify({
    data: Array.from({ length: count }, (_, index) => ({
      embedding: new Array(dimensions).fill(index + 0.1),
    })),
    usage: { total_tokens: count * 10 },
  }), { status: 200 });
}

function createVoyageResponse(count: number, dimensions: number): Response {
  return new Response(JSON.stringify({
    embeddings: Array.from({ length: count }, (_, index) => new Array(dimensions).fill(index + 0.1)),
    total_tokens: count * 10,
  }), { status: 200 });
}

function createGoogleResponse(count: number, dimensions: number): Response {
  return new Response(JSON.stringify({
    embeddings: Array.from({ length: count }, (_, index) => ({
      values: new Array(dimensions).fill(index + 0.1),
    })),
  }), { status: 200 });
}

function createOllamaResponse(dimensions: number): Response {
  return new Response(JSON.stringify({
    embedding: new Array(dimensions).fill(0.1),
  }), { status: 200 });
}

function getRejectedError<T>(promise: Promise<T>): Promise<Error> {
  return promise.then<Error>(
    () => {
      throw new Error("Expected promise to reject");
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error;
      }
      return new Error(String(error));
    }
  );
}

function createProviderInfo(provider: Exclude<ConfiguredProviderInfo["provider"], "custom">): ConfiguredProviderInfo {
  switch (provider) {
    case "github-copilot":
      return {
        provider,
        credentials: {
          provider,
          baseUrl: "https://models.github.ai",
          refreshToken: "github-test-token",
        },
        modelInfo: EMBEDDING_MODELS["github-copilot"]["text-embedding-3-small"],
      };
    case "openai":
      return {
        provider,
        credentials: {
          provider,
          baseUrl: "https://api.openai.com/v1",
          apiKey: "openai-test-key",
        },
        modelInfo: EMBEDDING_MODELS.openai["text-embedding-3-small"],
      };
    case "google":
      return {
        provider,
        credentials: {
          provider,
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "google-test-key",
        },
        modelInfo: EMBEDDING_MODELS.google["text-embedding-005"],
      };
    case "ollama":
      return {
        provider,
        credentials: {
          provider,
          baseUrl: "http://localhost:11434",
        },
        modelInfo: EMBEDDING_MODELS.ollama["nomic-embed-text"],
      };
  }
}

const providerCases: ProviderCase[] = [
  {
    name: "GitHub Copilot",
    dimensions: EMBEDDING_MODELS["github-copilot"]["text-embedding-3-small"].dimensions,
    createProvider: () => createEmbeddingProvider(createProviderInfo("github-copilot")),
    createSuccessResponse: createOpenAICompatibleResponse,
    createMalformedResponse: () => new Response(JSON.stringify({ data: "broken" }), { status: 200 }),
    createWrongDimensionResponse: () => createOpenAICompatibleResponse(
      1,
      EMBEDDING_MODELS["github-copilot"]["text-embedding-3-small"].dimensions - 1
    ),
  },
  {
    name: "OpenAI",
    dimensions: EMBEDDING_MODELS.openai["text-embedding-3-small"].dimensions,
    createProvider: () => createEmbeddingProvider(createProviderInfo("openai")),
    createSuccessResponse: createOpenAICompatibleResponse,
    createMalformedResponse: () => new Response(JSON.stringify({ data: [{}] }), { status: 200 }),
    createWrongDimensionResponse: () => createOpenAICompatibleResponse(
      1,
      EMBEDDING_MODELS.openai["text-embedding-3-small"].dimensions - 1
    ),
  },
  {
    name: "Google",
    dimensions: EMBEDDING_MODELS.google["text-embedding-005"].dimensions,
    createProvider: () => createEmbeddingProvider(createProviderInfo("google")),
    createSuccessResponse: createGoogleResponse,
    createMalformedResponse: () => new Response(JSON.stringify({ embeddings: [{}] }), { status: 200 }),
    createWrongDimensionResponse: () => createGoogleResponse(
      1,
      EMBEDDING_MODELS.google["text-embedding-005"].dimensions - 1
    ),
  },
  {
    name: "Ollama",
    dimensions: EMBEDDING_MODELS.ollama["nomic-embed-text"].dimensions,
    createProvider: () => createEmbeddingProvider(createProviderInfo("ollama")),
    createSuccessResponse: (_count, dimensions) => createOllamaResponse(dimensions ?? EMBEDDING_MODELS.ollama["nomic-embed-text"].dimensions),
    createMalformedResponse: () => new Response(JSON.stringify({ embedding: "broken" }), { status: 200 }),
    createWrongDimensionResponse: () => createOllamaResponse(
      EMBEDDING_MODELS.ollama["nomic-embed-text"].dimensions - 1
    ),
  },
  {
    name: "Custom",
    dimensions: 768,
    createProvider: () => createEmbeddingProvider(createCustomProviderInfo({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
      timeoutMs: 50,
    })),
    createSuccessResponse: createOpenAICompatibleResponse,
    createMalformedResponse: () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    createWrongDimensionResponse: () => createOpenAICompatibleResponse(1, 767),
  },
  {
    name: "Voyage",
    dimensions: 1536,
    createProvider: () => new VoyageEmbeddingProvider({ voyageApiKey: "voyage-test-key" }),
    createSuccessResponse: createVoyageResponse,
    createMalformedResponse: () => new Response(JSON.stringify({ embeddings: [{}] }), { status: 200 }),
    createWrongDimensionResponse: () => createVoyageResponse(1, 1535),
  },
];

const batchCapableCases = providerCases.filter((providerCase) => providerCase.name !== "Ollama");

describe("Embedding provider hardening", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(providerCases)("enforces request timeouts for $name", async (providerCase) => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    }));

    const provider = providerCase.createProvider();
    const promise = provider.embedQuery("timeout me");
    const settled = getRejectedError(promise);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(error).toBeInstanceOf(EmbeddingTransientError);
    expect(error.message).toContain("timed out");
  });

  it.each(providerCases)("rejects malformed responses for $name", async (providerCase) => {
    fetchSpy.mockResolvedValue(providerCase.createMalformedResponse());

    const provider = providerCase.createProvider();
    const error = await getRejectedError(provider.embedQuery("bad payload"));

    expect(error).toBeInstanceOf(EmbeddingValidationError);
    expect(error.message).toContain("malformed response");
  });

  it.each(providerCases)("rejects wrong dimensions for $name", async (providerCase) => {
    fetchSpy.mockResolvedValue(providerCase.createWrongDimensionResponse());

    const provider = providerCase.createProvider();
    const error = await getRejectedError(provider.embedQuery("wrong dims"));

    expect(error).toBeInstanceOf(EmbeddingValidationError);
    expect(error.message).toContain("Dimension mismatch");
  });

  it.each(batchCapableCases)("rejects partial embedding counts for $name", async (providerCase) => {
    fetchSpy.mockResolvedValue(providerCase.createSuccessResponse(1, providerCase.dimensions));

    const provider = providerCase.createProvider();
    const error = await getRejectedError(provider.embedBatch(["one", "two"]));

    expect(error).toBeInstanceOf(EmbeddingValidationError);
    expect(error.message).toContain("Embedding count mismatch");
  });

  it.each(providerCases)("retries transient failures for $name", async (providerCase) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    fetchSpy
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(providerCase.createSuccessResponse(1, providerCase.dimensions));

    const provider = providerCase.createProvider();
    const promise = provider.embedQuery("retry me");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.embedding).toHaveLength(providerCase.dimensions);
  });

  it("limits Ollama to two concurrent requests", async () => {
    const resolvers: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    fetchSpy.mockImplementation(() => new Promise<Response>((resolve) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      resolvers.push(() => {
        inFlight -= 1;
        resolve(createOllamaResponse(EMBEDDING_MODELS.ollama["nomic-embed-text"].dimensions));
      });
    }));

    const provider = createEmbeddingProvider(createProviderInfo("ollama"));
    const promise = provider.embedBatch(["a", "b", "c", "d"]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(resolvers).toHaveLength(2);

    resolvers.splice(0, 2).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(resolvers).toHaveLength(2);

    resolvers.splice(0, 2).forEach((resolve) => resolve());
    const result = await promise;
    expect(result.embeddings).toHaveLength(4);
  });
});
