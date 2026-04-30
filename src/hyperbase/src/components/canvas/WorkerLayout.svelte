<script lang="ts">
  import type Graph from 'graphology';
  import { onDestroy } from 'svelte';
  import { persistLayoutSnapshot } from '../../lib/layout-cache';
  import { graphContentId, graphInstance, graphLayoutCacheHit, graphLoadId, sigmaInstance } from '../../stores/graph';
  import { LAYOUT_ITERATIONS } from '../../lib/constants';
  import type { FileGraphNodeAttributes, GraphEdgeAttributes, SymbolGraphNodeAttributes } from '../../types';

  type HyperGraph = Graph<FileGraphNodeAttributes | SymbolGraphNodeAttributes, GraphEdgeAttributes>;

  let worker: Worker | null = null;
  let layoutRunning = false;
  let currentGraph: HyperGraph | null = null;
  let currentContentId: string | null = null;
  let currentLoadId = 0;
  let currentLayoutCacheHit = false;

  function layoutIterationsForGraph(graph: HyperGraph): number {
    if (graph.order < 30) {
      return 120;
    }
    if (graph.order <= 100) {
      return 240;
    }
    if (graph.order <= 300) {
      return 380;
    }
    return LAYOUT_ITERATIONS;
  }

  function stopWorker() {
    if (worker) {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
      worker = null;
    }
    layoutRunning = false;
  }

  function startWorker(graph: HyperGraph) {
    stopWorker();
    worker = new Worker(new URL('../../workers/layout.worker.ts', import.meta.url), { type: 'module' });
    layoutRunning = true;

    worker.onmessage = (event) => {
      const payload = event.data as
        | { type: 'progress'; positions: Record<string, { x: number; y: number }>; iteration: number; maxDelta: number }
        | { type: 'done'; positions: Record<string, { x: number; y: number }>; iteration: number; converged: boolean; maxDelta: number };

      Object.entries(payload.positions).forEach(([node, position]) => {
        if (graph.hasNode(node)) {
          graph.mergeNodeAttributes(node, position);
        }
      });

      sigmaInstance.update((sigma) => {
        sigma?.refresh();
        return sigma;
      });

      if (payload.type === 'done') {
        layoutRunning = false;
        if (currentContentId) {
          persistLayoutSnapshot(currentContentId, payload.positions);
        }
      }
    };

    worker.postMessage({
      type: 'start',
      graph: graph.export(),
      iterations: layoutIterationsForGraph(graph),
    });
  }

  const unsubscribers = [
    graphInstance.subscribe((graph) => {
      currentGraph = graph;
      if (!graph) {
        stopWorker();
      }
    }),
    graphContentId.subscribe((contentId) => {
      currentContentId = contentId;
    }),
    graphLayoutCacheHit.subscribe((cacheHit) => {
      currentLayoutCacheHit = cacheHit;
    }),
    graphLoadId.subscribe((loadId) => {
      if (!currentGraph || loadId === 0 || loadId === currentLoadId) {
        return;
      }

      currentLoadId = loadId;
      if (currentLayoutCacheHit) {
        stopWorker();
        sigmaInstance.update((sigma) => {
          sigma?.refresh();
          return sigma;
        });
        return;
      }

      startWorker(currentGraph);
    }),
  ];

  onDestroy(() => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    stopWorker();
  });
</script>

{#if layoutRunning}
  <div class="layout-indicator">Computing layout…</div>
{/if}

<style>
  .layout-indicator {
    position: fixed;
    bottom: var(--space-md);
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    padding: var(--space-xs) var(--space-md);
    border-radius: var(--radius-md);
    font-size: 12px;
    z-index: var(--z-controls);
    box-shadow: var(--shadow-sm);
  }
</style>
