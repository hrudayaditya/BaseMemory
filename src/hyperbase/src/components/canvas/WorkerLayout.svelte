<script lang="ts">
  import { onDestroy } from 'svelte';
  import { graphInstance, sigmaInstance } from '../../stores/graph';
  import { LAYOUT_ITERATIONS } from '../../lib/constants';

  let worker: Worker | null = null;
  let layoutRunning = false;
  let currentGraphKey = '';

  function stopWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    layoutRunning = false;
  }

  function startWorker(graph: NonNullable<Awaited<ReturnType<typeof graphInstance.subscribe>>>) {
    stopWorker();
    worker = new Worker(new URL('../../workers/layout.worker.ts', import.meta.url), { type: 'module' });
    layoutRunning = true;

    worker.onmessage = (event) => {
      const payload = event.data as
        | { type: 'progress'; positions: Record<string, { x: number; y: number }> }
        | { type: 'done'; positions: Record<string, { x: number; y: number }> };

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
      }
    };

    worker.postMessage({
      type: 'start',
      graph: graph.export(),
      iterations: LAYOUT_ITERATIONS,
    });
  }

  const unsubscribe = graphInstance.subscribe((graph) => {
    if (!graph) {
      stopWorker();
      return;
    }

    const nextKey = `${graph.order}:${graph.size}`;
    if (nextKey === currentGraphKey) {
      return;
    }

    currentGraphKey = nextKey;
    startWorker(graph);
  });

  onDestroy(() => {
    unsubscribe();
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
