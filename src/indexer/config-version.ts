import type { ConfiguredProviderInfo } from "../embeddings/detector.js";
import {
  EMBEDDING_INPUT_FORMAT_VERSION,
  getChunkerVersion,
  getGraphExtractorVersion,
  hashContent,
} from "../native/index.js";

export interface ConfigVersion {
  embeddingModelId: string;
  embeddingDimension: number;
  embeddingMaxTokens: number;
  embeddingProvider: ConfiguredProviderInfo["provider"];
  endpointBaseUrl: string;
  documentTaskType: string;
  voyageModelId: string | null;
  embeddingPrefixVersion: number;
  chunkerVersion: string;
  graphExtractorVersion: string;
}

interface EmbedConfigIdentity {
  embeddingDimension: number;
  embeddingModelId: string;
  embeddingMaxTokens: number;
  embeddingProvider: ConfiguredProviderInfo["provider"];
  endpointBaseUrl: string;
  documentTaskType: string;
  voyageModelId: string | null;
  embeddingPrefixVersion: number;
}

function hashSortedObject(value: Record<string, number | string | null>): string {
  return hashContent(JSON.stringify(value));
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return baseUrl?.replace(/\/+$/, "") ?? "";
}

function getDocumentTaskType(configuredProviderInfo: ConfiguredProviderInfo): string {
  if (
    configuredProviderInfo.provider === "google" &&
    configuredProviderInfo.modelInfo.taskAble
  ) {
    return "RETRIEVAL_DOCUMENT";
  }

  return "";
}

function buildEmbedConfigIdentity(
  configuredProviderInfo: ConfiguredProviderInfo,
  voyageModelId: string | null = null,
  voyageMaxTokens: number | null = null
): EmbedConfigIdentity {
  const primaryMaxTokens = configuredProviderInfo.modelInfo.maxTokens;
  const embeddingMaxTokens =
    voyageModelId == null || voyageMaxTokens == null
      ? primaryMaxTokens
      : Math.min(primaryMaxTokens, voyageMaxTokens);

  return {
    embeddingDimension: configuredProviderInfo.modelInfo.dimensions,
    embeddingModelId: configuredProviderInfo.modelInfo.model,
    embeddingMaxTokens,
    embeddingProvider: configuredProviderInfo.provider,
    endpointBaseUrl: normalizeBaseUrl(configuredProviderInfo.credentials.baseUrl),
    documentTaskType: getDocumentTaskType(configuredProviderInfo),
    voyageModelId,
    embeddingPrefixVersion: EMBEDDING_INPUT_FORMAT_VERSION,
  };
}

/**
 * Deterministic hash of a ConfigVersion.
 * Used as config_hash in pipeline_runs and config_versions.
 */
export function hashConfigVersion(cv: ConfigVersion): string {
  const sorted = {
    embeddingDimension: cv.embeddingDimension,
    embeddingModelId: cv.embeddingModelId,
    embeddingMaxTokens: cv.embeddingMaxTokens,
    embeddingProvider: cv.embeddingProvider,
    endpointBaseUrl: cv.endpointBaseUrl,
    documentTaskType: cv.documentTaskType,
    voyageModelId: cv.voyageModelId,
    embeddingPrefixVersion: cv.embeddingPrefixVersion,
    chunkerVersion: cv.chunkerVersion,
    graphExtractorVersion: cv.graphExtractorVersion,
  };

  return hashSortedObject(sorted);
}

/**
 * Hash of just the embedding portion of a ConfigVersion.
 * Used as embed_config_hash in EMBED stage input_hash computation.
 */
export function hashEmbedConfig(
  configuredProviderInfo: ConfiguredProviderInfo,
  voyageModelId: string | null = null,
  voyageMaxTokens: number | null = null
): string {
  const identity = buildEmbedConfigIdentity(configuredProviderInfo, voyageModelId, voyageMaxTokens);
  const sorted = {
    documentTaskType: identity.documentTaskType,
    embeddingDimension: identity.embeddingDimension,
    embeddingModelId: identity.embeddingModelId,
    embeddingMaxTokens: identity.embeddingMaxTokens,
    embeddingProvider: identity.embeddingProvider,
    endpointBaseUrl: identity.endpointBaseUrl,
    voyageModelId: identity.voyageModelId,
    embeddingPrefixVersion: identity.embeddingPrefixVersion,
  };

  return hashSortedObject(sorted);
}

/**
 * Builds a ConfigVersion from the current runtime state.
 */
export async function getCurrentConfigVersion(
  configuredProviderInfo: ConfiguredProviderInfo,
  voyageModelId: string | null = null,
  voyageMaxTokens: number | null = null
): Promise<ConfigVersion> {
  const embedIdentity = buildEmbedConfigIdentity(
    configuredProviderInfo,
    voyageModelId,
    voyageMaxTokens
  );

  return {
    embeddingModelId: embedIdentity.embeddingModelId,
    embeddingDimension: embedIdentity.embeddingDimension,
    embeddingMaxTokens: embedIdentity.embeddingMaxTokens,
    embeddingProvider: embedIdentity.embeddingProvider,
    endpointBaseUrl: embedIdentity.endpointBaseUrl,
    documentTaskType: embedIdentity.documentTaskType,
    voyageModelId: embedIdentity.voyageModelId,
    embeddingPrefixVersion: embedIdentity.embeddingPrefixVersion,
    chunkerVersion: getChunkerVersion(),
    graphExtractorVersion: getGraphExtractorVersion(),
  };
}
