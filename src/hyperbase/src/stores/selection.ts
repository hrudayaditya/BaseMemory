import { get, writable } from 'svelte/store';
import { fetchPeek, fetchSymbol, isAbortError } from '../api/client';
import type { FileNode, GraphNode, PeekResult, SymbolDetail } from '../types';
import { activeBranch, graphInstance } from './graph';
import { sidebarOpen } from './ui';

type SelectableNodeData = GraphNode | FileNode | Record<string, unknown> | null;

export const selectedNodeId = writable<string | null>(null);
export const hoveredNodeId = writable<string | null>(null);
export const selectedNodeData = writable<SelectableNodeData>(null);
export const selectedSymbolDetail = writable<SymbolDetail | null>(null);
export const selectedSymbolPeek = writable<PeekResult | null>(null);
export const detailLoading = writable<boolean>(false);

let detailAbortController: AbortController | null = null;
let detailRequestRevision = 0;
let currentBranch = '';
let currentSelectedNodeId: string | null = null;

function resolveCurrentNodeData(nodeId: string): SelectableNodeData {
  const graph = get(graphInstance);
  if (graph && graph.hasNode(nodeId)) {
    return graph.getNodeAttributes(nodeId) as SelectableNodeData;
  }
  return null;
}

function resetDetailState(): void {
  detailAbortController?.abort();
  detailAbortController = null;
  selectedSymbolDetail.set(null);
  selectedSymbolPeek.set(null);
  detailLoading.set(false);
}

async function loadDetailForNode(nodeId: string): Promise<void> {
  if (!currentBranch || !nodeId || nodeId.startsWith('file::')) {
    resetDetailState();
    return;
  }

  detailAbortController?.abort();
  const abortController = new AbortController();
  detailAbortController = abortController;
  const revision = detailRequestRevision + 1;
  detailRequestRevision = revision;

  detailLoading.set(true);

  try {
    const [detail, peek] = await Promise.all([
      fetchSymbol(nodeId, currentBranch, abortController.signal),
      fetchPeek(nodeId, currentBranch, abortController.signal),
    ]);

    const stillCurrent =
      detailRequestRevision === revision && !abortController.signal.aborted && get(selectedNodeId) === nodeId;
    if (!stillCurrent) {
      return;
    }

    selectedSymbolDetail.set(detail);
    selectedSymbolPeek.set(peek);
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }

    const stillCurrent =
      detailRequestRevision === revision && !abortController.signal.aborted && get(selectedNodeId) === nodeId;
    if (!stillCurrent) {
      return;
    }

    selectedSymbolDetail.set(null);
    selectedSymbolPeek.set(null);
  } finally {
    if (detailRequestRevision === revision) {
      detailLoading.set(false);
    }
  }
}

activeBranch.subscribe((value) => {
  currentBranch = value;
  if (currentSelectedNodeId && !currentSelectedNodeId.startsWith('file::')) {
    void loadDetailForNode(currentSelectedNodeId);
  }
});

graphInstance.subscribe((graph) => {
  if (!graph || !currentSelectedNodeId || !graph.hasNode(currentSelectedNodeId)) {
    return;
  }

  selectedNodeData.set(graph.getNodeAttributes(currentSelectedNodeId) as SelectableNodeData);
});

export async function selectNode(nodeId: string | null, nodeData?: SelectableNodeData): Promise<void> {
  currentSelectedNodeId = nodeId;
  selectedNodeId.set(nodeId);

  if (!nodeId) {
    selectedNodeData.set(null);
    resetDetailState();
    sidebarOpen.set(false);
    return;
  }

  const nextNodeData = nodeData ?? resolveCurrentNodeData(nodeId);
  selectedNodeData.set(nextNodeData);
  sidebarOpen.set(true);

  if (nodeId.startsWith('file::')) {
    resetDetailState();
    return;
  }

  await loadDetailForNode(nodeId);
}

export function clearSelectedNode(): void {
  void selectNode(null);
}

export async function refreshSelectedNode(): Promise<void> {
  if (!currentSelectedNodeId || currentSelectedNodeId.startsWith('file::')) {
    return;
  }

  await loadDetailForNode(currentSelectedNodeId);
}
