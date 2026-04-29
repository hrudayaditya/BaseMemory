import type {
  BlastRadiusResponse,
  DirectoryGraphResponse,
  FullGraphResponse,
  NeighborhoodResponse,
  PathResponse,
  PeekResult,
  SearchResult,
  SymbolDetail,
} from '../types';

const API_BASE = '/api';

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.code ?? 'UNKNOWN', body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function fetchBranches(signal?: AbortSignal): Promise<string[]> {
  const response = await request<{ branches: string[] }>('/branches', signal);
  return response.branches;
}

export async function searchSymbols(q: string, branch: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const response = await request<{ results: SearchResult[] }>(
    `/search?q=${encodeURIComponent(q)}&branch=${encodeURIComponent(branch)}`,
    signal
  );
  return response.results;
}

export async function fetchFullGraph(branch: string, signal?: AbortSignal): Promise<FullGraphResponse> {
  return request<FullGraphResponse>(`/graph/full?branch=${encodeURIComponent(branch)}`, signal);
}

export async function fetchNeighborhood(
  id: string,
  branch: string,
  depth: number,
  signal?: AbortSignal
): Promise<NeighborhoodResponse> {
  return request<NeighborhoodResponse>(
    `/neighborhood/${encodeURIComponent(id)}?branch=${encodeURIComponent(branch)}&depth=${depth}`,
    signal
  );
}

export async function fetchSymbol(id: string, branch: string, signal?: AbortSignal): Promise<SymbolDetail> {
  const response = await request<{ symbol: SymbolDetail }>(
    `/symbol/${encodeURIComponent(id)}?branch=${encodeURIComponent(branch)}`,
    signal
  );
  return response.symbol;
}

export async function fetchPeek(symbolId: string, branch: string, signal?: AbortSignal): Promise<PeekResult> {
  return request<PeekResult>(`/peek/${encodeURIComponent(symbolId)}?branch=${encodeURIComponent(branch)}`, signal);
}

export async function fetchBlastRadius(id: string, branch: string, signal?: AbortSignal): Promise<BlastRadiusResponse> {
  return request<BlastRadiusResponse>(
    `/blast-radius/${encodeURIComponent(id)}?branch=${encodeURIComponent(branch)}`,
    signal
  );
}

export async function fetchDirectoryGraph(
  directoryPath: string,
  branch: string,
  signal?: AbortSignal
): Promise<DirectoryGraphResponse> {
  return request<DirectoryGraphResponse>(
    `/graph/directory?path=${encodeURIComponent(directoryPath)}&branch=${encodeURIComponent(branch)}`,
    signal
  );
}

export async function fetchPath(from: string, to: string, branch: string, signal?: AbortSignal): Promise<PathResponse> {
  return request<PathResponse>(
    `/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&branch=${encodeURIComponent(branch)}`,
    signal
  );
}
