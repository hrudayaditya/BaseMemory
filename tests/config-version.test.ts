import { describe, expect, it } from "vitest";

import { EMBEDDING_MODELS } from "../src/config/constants.js";
import {
  createCustomProviderInfo,
  type ConfiguredProviderInfo,
} from "../src/embeddings/detector.js";
import {
  type ConfigVersion,
  getCurrentConfigVersion,
  hashConfigVersion,
  hashEmbedConfig,
} from "../src/indexer/config-version.js";
import { getChunkerVersion } from "../src/native/index.js";

function createOpenAiProvider(): ConfiguredProviderInfo {
  return {
    provider: "openai",
    credentials: {
      provider: "openai",
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
    },
    modelInfo: EMBEDDING_MODELS.openai["text-embedding-3-small"],
  };
}

function createGitHubCopilotProvider(): ConfiguredProviderInfo {
  return {
    provider: "github-copilot",
    credentials: {
      provider: "github-copilot",
      baseUrl: "https://models.github.ai",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      tokenExpires: 0,
    },
    modelInfo: EMBEDDING_MODELS["github-copilot"]["text-embedding-3-small"],
  };
}

function createGoogleProvider(taskAble: boolean): ConfiguredProviderInfo {
  return {
    provider: "google",
    credentials: {
      provider: "google",
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    },
    modelInfo: {
      ...EMBEDDING_MODELS.google["gemini-embedding-001"],
      taskAble,
    },
  } as ConfiguredProviderInfo;
}

describe("config-version", () => {
  it("returns a stable non-empty chunker version", () => {
    const versionA = getChunkerVersion();
    const versionB = getChunkerVersion();

    expect(versionA).toBeTruthy();
    expect(versionA).toBe(versionB);
  });

  it("hashConfigVersion is deterministic and order-independent", () => {
    const base: ConfigVersion = {
      embeddingModelId: "text-embedding-3-small",
      embeddingDimension: 1536,
      embeddingProvider: "openai",
      endpointBaseUrl: "https://api.openai.com/v1",
      documentTaskType: "",
      chunkerVersion: "chunker-v1",
      graphExtractorVersion: "1.0.0",
    };

    const reordered = {
      documentTaskType: "",
      endpointBaseUrl: "https://api.openai.com/v1",
      embeddingProvider: "openai",
      graphExtractorVersion: "1.0.0",
      chunkerVersion: "chunker-v1",
      embeddingDimension: 1536,
      embeddingModelId: "text-embedding-3-small",
    } as ConfigVersion;

    expect(hashConfigVersion(base)).toBe(hashConfigVersion(base));
    expect(hashConfigVersion(base)).toBe(hashConfigVersion(reordered));
  });

  it("hashConfigVersion changes when any field changes", () => {
    const base: ConfigVersion = {
      embeddingModelId: "text-embedding-3-small",
      embeddingDimension: 1536,
      embeddingProvider: "openai",
      endpointBaseUrl: "https://api.openai.com/v1",
      documentTaskType: "",
      chunkerVersion: "chunker-v1",
      graphExtractorVersion: "1.0.0",
    };

    expect(hashConfigVersion(base)).not.toBe(hashConfigVersion({
      ...base,
      embeddingModelId: "text-embedding-3-large",
    }));
    expect(hashConfigVersion(base)).not.toBe(hashConfigVersion({
      ...base,
      embeddingDimension: 3072,
    }));
    expect(hashConfigVersion(base)).not.toBe(hashConfigVersion({
      ...base,
      embeddingProvider: "github-copilot",
    }));
    expect(hashConfigVersion(base)).not.toBe(hashConfigVersion({
      ...base,
      endpointBaseUrl: "https://models.github.ai",
    }));
    expect(hashConfigVersion(base)).not.toBe(hashConfigVersion({
      ...base,
      documentTaskType: "RETRIEVAL_DOCUMENT",
    }));
    expect(hashConfigVersion(base)).not.toBe(hashConfigVersion({
      ...base,
      chunkerVersion: "chunker-v2",
    }));
    expect(hashConfigVersion(base)).not.toBe(hashConfigVersion({
      ...base,
      graphExtractorVersion: "2.0.0",
    }));
  });

  it("hashEmbedConfig changes when provider type changes for the same model and dimension", () => {
    const openAiProvider = createOpenAiProvider();
    const gitHubProvider = createGitHubCopilotProvider();

    expect(openAiProvider.modelInfo.model).toBe(gitHubProvider.modelInfo.model);
    expect(openAiProvider.modelInfo.dimensions).toBe(gitHubProvider.modelInfo.dimensions);
    expect(hashEmbedConfig(openAiProvider)).not.toBe(hashEmbedConfig(gitHubProvider));
  });

  it("hashEmbedConfig changes when the endpoint changes for the same provider and model", () => {
    const providerA = createCustomProviderInfo({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
    });
    const providerB = createCustomProviderInfo({
      baseUrl: "http://localhost:22434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
    });

    expect(hashEmbedConfig(providerA)).not.toBe(hashEmbedConfig(providerB));
  });

  it("hashEmbedConfig changes when google document task type changes", () => {
    const taskAwareProvider = createGoogleProvider(true);
    const defaultTaskProvider = createGoogleProvider(false);

    expect(taskAwareProvider.modelInfo.model).toBe(defaultTaskProvider.modelInfo.model);
    expect(taskAwareProvider.modelInfo.dimensions).toBe(defaultTaskProvider.modelInfo.dimensions);
    expect(hashEmbedConfig(taskAwareProvider)).not.toBe(hashEmbedConfig(defaultTaskProvider));
  });

  it("hashConfigVersion changes when provider identity changes for the same model and dimension", async () => {
    const openAiProvider = createOpenAiProvider();
    const gitHubProvider = createGitHubCopilotProvider();

    const openAiConfigVersion = {
      ...(await getCurrentConfigVersion(openAiProvider)),
      chunkerVersion: "chunker-v1",
    };
    const gitHubConfigVersion = {
      ...(await getCurrentConfigVersion(gitHubProvider)),
      chunkerVersion: "chunker-v1",
    };

    expect(openAiProvider.modelInfo.model).toBe(gitHubProvider.modelInfo.model);
    expect(openAiProvider.modelInfo.dimensions).toBe(gitHubProvider.modelInfo.dimensions);
    expect(hashConfigVersion(openAiConfigVersion)).not.toBe(hashConfigVersion(gitHubConfigVersion));
  });

  it("builds the current config version from configured provider info", async () => {
    const providerInfo = createCustomProviderInfo({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
    });

    const configVersion = await getCurrentConfigVersion(providerInfo);

    expect(configVersion).toEqual({
      embeddingModelId: "nomic-embed-text",
      embeddingDimension: 768,
      embeddingProvider: "custom",
      endpointBaseUrl: "http://localhost:11434/v1",
      documentTaskType: "",
      chunkerVersion: getChunkerVersion(),
      graphExtractorVersion: "1.0.0",
    });
  });
});
