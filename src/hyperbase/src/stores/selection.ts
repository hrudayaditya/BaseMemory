import { writable } from 'svelte/store';
import type { FileNode, GraphNode, PeekResult, SymbolDetail } from '../types';

export const selectedNodeId = writable<string | null>(null);
export const hoveredNodeId = writable<string | null>(null);
export const selectedNodeData = writable<GraphNode | FileNode | null>(null);
export const selectedSymbolDetail = writable<SymbolDetail | null>(null);
export const selectedSymbolPeek = writable<PeekResult | null>(null);
export const detailLoading = writable<boolean>(false);
