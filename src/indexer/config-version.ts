import type { ConfiguredProviderInfo } from "../embeddings/detector.js";
import { getChunkerVersion, hashContent } from "../native/index.js";

export interface ConfigVersion {
  embeddingModelId: string;
  embeddingDimension: number;
  embeddingProvider: ConfiguredProviderInfo["provider"];
  endpointBaseUrl: string;
  documentTaskType: string;
  chunkerVersion: string;
  graphExtractorVersion: string;
}

interface EmbedConfigIdentity {
  embeddingDimension: number;
  embeddingModelId: string;
  embeddingProvider: ConfiguredProviderInfo["provider"];
  endpointBaseUrl: string;
  documentTaskType: string;
}

function hashSortedObject(value: Record<string, number | string>): string {
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
  configuredProviderInfo: ConfiguredProviderInfo
): EmbedConfigIdentity {
  return {
    embeddingDimension: configuredProviderInfo.modelInfo.dimensions,
    embeddingModelId: configuredProviderInfo.modelInfo.model,
    embeddingProvider: configuredProviderInfo.provider,
    endpointBaseUrl: normalizeBaseUrl(configuredProviderInfo.credentials.baseUrl),
    documentTaskType: getDocumentTaskType(configuredProviderInfo),
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
    embeddingProvider: cv.embeddingProvider,
    endpointBaseUrl: cv.endpointBaseUrl,
    documentTaskType: cv.documentTaskType,
    chunkerVersion: cv.chunkerVersion,
    graphExtractorVersion: cv.graphExtractorVersion,
  };

  return hashSortedObject(sorted);
}

/**
 * Hash of just the embedding portion of a ConfigVersion.
 * Used as embed_config_hash in EMBED stage input_hash computation.
 */
export function hashEmbedConfig(configuredProviderInfo: ConfiguredProviderInfo): string {
  const identity = buildEmbedConfigIdentity(configuredProviderInfo);
  const sorted = {
    documentTaskType: identity.documentTaskType,
    embeddingDimension: identity.embeddingDimension,
    embeddingModelId: identity.embeddingModelId,
    embeddingProvider: identity.embeddingProvider,
    endpointBaseUrl: identity.endpointBaseUrl,
  };

  return hashSortedObject(sorted);
}

/**
 * Builds a ConfigVersion from the current runtime state.
 */
export async function getCurrentConfigVersion(
  configuredProviderInfo: ConfiguredProviderInfo
): Promise<ConfigVersion> {
  const embedIdentity = buildEmbedConfigIdentity(configuredProviderInfo);

  return {
    embeddingModelId: embedIdentity.embeddingModelId,
    embeddingDimension: embedIdentity.embeddingDimension,
    embeddingProvider: embedIdentity.embeddingProvider,
    endpointBaseUrl: embedIdentity.endpointBaseUrl,
    documentTaskType: embedIdentity.documentTaskType,
    chunkerVersion: getChunkerVersion(),
    graphExtractorVersion: "1.0.0",
  };
}
