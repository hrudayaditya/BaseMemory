import type {
  BlastRadiusResponse,
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

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.code ?? 'UNKNOWN', body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function fetchBranches(): Promise<string[]> {
  const response = await request<{ branches: string[] }>('/branches');
  return response.branches;
}

export async function searchSymbols(q: string, branch: string): Promise<SearchResult[]> {
  const response = await request<{ results: SearchResult[] }>(
    `/search?q=${encodeURIComponent(q)}&branch=${encodeURIComponent(branch)}`
  );
  return response.results;
}

export async function fetchFullGraph(branch: string): Promise<FullGraphResponse> {
  return request<FullGraphResponse>(`/graph/full?branch=${encodeURIComponent(branch)}`);
}

export async function fetchNeighborhood(id: string, branch: string, depth: number): Promise<NeighborhoodResponse> {
  return request<NeighborhoodResponse>(
    `/neighborhood/${encodeURIComponent(id)}?branch=${encodeURIComponent(branch)}&depth=${depth}`
  );
}

export async function fetchSymbol(id: string, branch: string): Promise<SymbolDetail> {
  const response = await request<{ symbol: SymbolDetail }>(
    `/symbol/${encodeURIComponent(id)}?branch=${encodeURIComponent(branch)}`
  );
  return response.symbol;
}

export async function fetchPeek(symbolId: string, branch: string): Promise<PeekResult> {
  return request<PeekResult>(`/peek/${encodeURIComponent(symbolId)}?branch=${encodeURIComponent(branch)}`);
}

export async function fetchBlastRadius(id: string, branch: string): Promise<BlastRadiusResponse> {
  return request<BlastRadiusResponse>(`/blast-radius/${encodeURIComponent(id)}?branch=${encodeURIComponent(branch)}`);
}

export async function fetchPath(from: string, to: string, branch: string): Promise<PathResponse> {
  return request<PathResponse>(
    `/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&branch=${encodeURIComponent(branch)}`
  );
}
