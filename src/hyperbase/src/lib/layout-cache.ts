import type Graph from 'graphology';

const STORAGE_PREFIX = 'hyperbase:layout:v1:';

type StoredLayout = {
  graphContentId: string;
  savedAt: string;
  positions: Record<string, { x: number; y: number }>;
};

function storageKey(graphContentId: string): string {
  return `${STORAGE_PREFIX}${graphContentId}`;
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function isFinitePosition(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { x?: unknown; y?: unknown };
  return typeof candidate.x === 'number' && Number.isFinite(candidate.x) && typeof candidate.y === 'number' && Number.isFinite(candidate.y);
}

export function restoreLayoutSnapshot(graph: Graph, graphContentId: string): boolean {
  if (!hasStorage()) {
    return false;
  }

  const key = storageKey(graphContentId);

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return false;
    }

    const parsed = JSON.parse(raw) as Partial<StoredLayout>;
    if (parsed.graphContentId !== graphContentId || !parsed.positions || typeof parsed.positions !== 'object') {
      window.localStorage.removeItem(key);
      return false;
    }

    const nodeIds = graph.nodes();
    const positionEntries = Object.entries(parsed.positions);
    if (positionEntries.length !== nodeIds.length) {
      window.localStorage.removeItem(key);
      return false;
    }

    for (const nodeId of nodeIds) {
      const position = parsed.positions[nodeId];
      if (!isFinitePosition(position)) {
        window.localStorage.removeItem(key);
        return false;
      }
    }

    nodeIds.forEach((nodeId) => {
      const position = parsed.positions![nodeId]!;
      graph.mergeNodeAttributes(nodeId, position);
    });

    return true;
  } catch {
    window.localStorage.removeItem(key);
    return false;
  }
}

export function persistLayoutSnapshot(
  graphContentId: string,
  positions: Record<string, { x: number; y: number }>
): void {
  if (!hasStorage()) {
    return;
  }

  const payload: StoredLayout = {
    graphContentId,
    savedAt: new Date().toISOString(),
    positions,
  };

  try {
    window.localStorage.setItem(storageKey(graphContentId), JSON.stringify(payload));
  } catch {
    // Ignore storage quota or serialization failures; layout persistence is opportunistic.
  }
}
