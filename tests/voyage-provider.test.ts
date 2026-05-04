import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EmbeddingTransientError,
  VoyageEmbeddingProvider,
} from "../src/embeddings/provider.js";

const VOYAGE_CODE_3_DIMENSIONS = 1024;

describe("VoyageEmbeddingProvider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function createEmbedding(value: number): number[] {
    return new Array(VOYAGE_CODE_3_DIMENSIONS).fill(value);
  }

  function createProvider(overrides?: {
    voyageApiKey?: string;
    voyageModelId?: string;
  }): VoyageEmbeddingProvider {
    return new VoyageEmbeddingProvider({
      voyageApiKey: overrides?.voyageApiKey,
      voyageModelId: overrides?.voyageModelId,
    });
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns null immediately and makes no network requests when the API key is missing", async () => {
    const provider = createProvider();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("voyageApiKey is missing")
    );
    await expect(provider.embedQuery("find indexer")).resolves.toBeNull();
    await expect(provider.embedBatch(["a", "b"])).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends document batches with input_type=document and preserves result order", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      embeddings: [createEmbedding(0.1), createEmbedding(0.2)],
      total_tokens: 22,
    }), { status: 200 }));

    const provider = createProvider({ voyageApiKey: "voyage-test-key" });
    const result = await provider.embedBatch(["doc one", "doc two"]);

    expect(result).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(options.method).toBe("POST");
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer voyage-test-key");
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      input: ["doc one", "doc two"],
      model: "voyage-code-3",
      input_type: "document",
    });
    expect(result!.totalTokensUsed).toBe(22);
    expect(result!.embeddings).toHaveLength(2);
    expect(result!.embeddings[0]?.[0]).toBeCloseTo(0.1);
    expect(result!.embeddings[1]?.[0]).toBeCloseTo(0.2);
  });

  it("sends query embeddings with input_type=query", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      embeddings: [createEmbedding(0.3)],
      total_tokens: 9,
    }), { status: 200 }));

    const provider = createProvider({ voyageApiKey: "voyage-test-key" });
    const result = await provider.embedQuery("rank hybrid results");

    expect(result).not.toBeNull();
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.input_type).toBe("query");
    expect(result!.embedding[0]).toBeCloseTo(0.3);
  });

  it("batches requests into chunks of 128 and returns embeddings in original order", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({
        embeddings: Array.from({ length: 128 }, (_, index) => createEmbedding(index)),
        total_tokens: 1280,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        embeddings: Array.from({ length: 128 }, (_, index) => createEmbedding(index + 128)),
        total_tokens: 1280,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        embeddings: Array.from({ length: 44 }, (_, index) => createEmbedding(index + 256)),
        total_tokens: 440,
      }), { status: 200 }));

    const provider = createProvider({ voyageApiKey: "voyage-test-key" });
    const texts = Array.from({ length: 300 }, (_, index) => `document-${index}`);
    const result = await provider.embedBatch(texts);

    expect(result).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string).input).toHaveLength(128);
    expect(JSON.parse((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string).input).toHaveLength(128);
    expect(JSON.parse((fetchSpy.mock.calls[2] as [string, RequestInit])[1].body as string).input).toHaveLength(44);
    expect(result!.embeddings).toHaveLength(300);
    expect(result!.embeddings[0]?.[0]).toBe(0);
    expect(result!.embeddings[127]?.[0]).toBe(127);
    expect(result!.embeddings[128]?.[0]).toBe(128);
    expect(result!.embeddings[299]?.[0]).toBe(299);
  });

  it("retries failed requests and succeeds on the third attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    fetchSpy
      .mockResolvedValueOnce(new Response("temporary failure", { status: 500 }))
      .mockResolvedValueOnce(new Response("still failing", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        embeddings: [createEmbedding(0.4)],
        total_tokens: 7,
      }), { status: 200 }));

    const provider = createProvider({ voyageApiKey: "voyage-test-key" });
    const promise = provider.embedQuery("retry me");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result).not.toBeNull();
    expect(result!.embedding[0]).toBeCloseTo(0.4);
  });

  it("throws a transient error when all retries are exhausted", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    fetchSpy
      .mockResolvedValueOnce(new Response("failure one", { status: 500 }))
      .mockResolvedValueOnce(new Response("failure two", { status: 500 }))
      .mockResolvedValueOnce(new Response("failure three", { status: 500 }));

    const provider = createProvider({ voyageApiKey: "voyage-test-key" });
    const promise = provider.embedBatch(["doc"]);
    const settled = promise.then<Error>(
      () => {
        throw new Error("Expected promise to reject");
      },
      (failure: unknown) => failure instanceof Error ? failure : new Error(String(failure))
    );
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(EmbeddingTransientError);
    expect(error.message).toContain("500");
  });

  it("treats rate limits as retryable failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    fetchSpy
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        embeddings: [createEmbedding(0.5)],
        total_tokens: 6,
      }), { status: 200 }));

    const provider = createProvider({ voyageApiKey: "voyage-test-key" });
    const promise = provider.embedQuery("rate limited query");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result).not.toBeNull();
    expect(result!.embedding[0]).toBeCloseTo(0.5);
  });
});
