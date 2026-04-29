<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import GraphCanvas from './components/canvas/GraphCanvas.svelte';
  import WorkerLayout from './components/canvas/WorkerLayout.svelte';
  import SearchBar from './components/search/SearchBar.svelte';
  import DetailPanel from './components/panels/DetailPanel.svelte';
  import ControlBar from './components/controls/ControlBar.svelte';
  import Minimap from './components/minimap/Minimap.svelte';
  import { fetchBranches, fetchFullGraph, fetchNeighborhood } from './api/client';
  import { buildGraphologyInstance, buildNeighborhoodGraphologyInstance } from './lib/graph-utils';
  import { readUrlState, writeUrlState } from './lib/url-state';
  import {
    activeBranch,
    availableBranches,
    fileEdges,
    fileNodes,
    focusedSymbolId,
    graphEdgeCount,
    graphError,
    graphInstance,
    graphLoading,
    graphNodeCount,
    graphTruncated,
  } from './stores/graph';
  import { selectedNodeId } from './stores/selection';
  import { graphDepth } from './stores/ui';

  let mounted = false;
  let branch = '';
  let depth = 1;
  let centerSymbolId: string | null = null;
  let truncationDismissed = false;

  async function loadGalaxyView(nextBranch: string) {
    graphLoading.set(true);
    graphError.set(null);
    try {
      const fullGraph = await fetchFullGraph(nextBranch);
      fileNodes.set(fullGraph.nodes);
      fileEdges.set(fullGraph.edges);
      const graph = buildGraphologyInstance(fullGraph.nodes, fullGraph.edges);
      graphInstance.set(graph);
      graphNodeCount.set(fullGraph.nodes.length);
      graphEdgeCount.set(fullGraph.edges.length);
      graphTruncated.set(false);
      focusedSymbolId.set(null);
    } catch (error) {
      graphError.set(error instanceof Error ? error.message : 'Failed to load graph');
    } finally {
      graphLoading.set(false);
    }
  }

  async function loadNeighborhoodView(symbolId: string, nextBranch: string, nextDepth: number) {
    graphLoading.set(true);
    graphError.set(null);
    try {
      const neighborhood = await fetchNeighborhood(symbolId, nextBranch, nextDepth);
      const graph = buildNeighborhoodGraphologyInstance(neighborhood.nodes, neighborhood.edges);
      graphInstance.set(graph);
      graphNodeCount.set(neighborhood.nodes.length);
      graphEdgeCount.set(neighborhood.edges.length);
      graphTruncated.set(neighborhood.truncated);
      focusedSymbolId.set(symbolId);
    } catch (error) {
      graphError.set(error instanceof Error ? error.message : 'Failed to load neighborhood');
    } finally {
      graphLoading.set(false);
    }
  }

  async function loadInitial() {
    graphLoading.set(true);
    graphError.set(null);

    try {
      const branches = await fetchBranches();
      availableBranches.set(branches);

      const urlState = readUrlState();
      const initialBranch = urlState.branch && branches.includes(urlState.branch) ? urlState.branch : branches[0] ?? '';
      const initialDepth = urlState.depth && [1, 2, 3].includes(urlState.depth) ? urlState.depth : 1;

      activeBranch.set(initialBranch);
      graphDepth.set(initialDepth);

      if (urlState.symbolId) {
        selectedNodeId.set(urlState.symbolId);
        await loadNeighborhoodView(urlState.symbolId, initialBranch, initialDepth);
      } else {
        await loadGalaxyView(initialBranch);
      }
    } catch (error) {
      graphError.set(error instanceof Error ? error.message : 'Failed to load graph');
      graphLoading.set(false);
    }
  }

  function retry() {
    if (centerSymbolId && branch) {
      void loadNeighborhoodView(centerSymbolId, branch, depth);
    } else if (branch) {
      void loadGalaxyView(branch);
    } else {
      void loadInitial();
    }
  }

  const unsubscribers = [
    activeBranch.subscribe((value) => {
      branch = value;
      if (!mounted || !value) return;
      if (centerSymbolId) {
        void loadNeighborhoodView(centerSymbolId, value, depth);
      } else {
        void loadGalaxyView(value);
      }
    }),
    graphDepth.subscribe((value) => {
      depth = value;
      if (!mounted || !centerSymbolId || !branch) return;
      void loadNeighborhoodView(centerSymbolId, branch, value);
    }),
    focusedSymbolId.subscribe((value) => {
      centerSymbolId = value;
      if (!mounted) return;
      writeUrlState({
        branch,
        symbolId: value ?? undefined,
        depth,
        view: value ? 'atom' : 'galaxy',
      });
    }),
    activeBranch.subscribe((value) => {
      if (!mounted) return;
      writeUrlState({
        branch: value,
        symbolId: centerSymbolId ?? undefined,
        depth,
        view: centerSymbolId ? 'atom' : 'galaxy',
      });
    }),
    graphDepth.subscribe((value) => {
      if (!mounted) return;
      writeUrlState({
        branch,
        symbolId: centerSymbolId ?? undefined,
        depth: value,
        view: centerSymbolId ? 'atom' : 'galaxy',
      });
    }),
  ];

  onMount(async () => {
    mounted = true;
    await loadInitial();
  });

  onDestroy(() => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });
</script>

<div class="app">
  <GraphCanvas />
  <WorkerLayout />
  <SearchBar />
  <ControlBar />
  <DetailPanel />
  <Minimap />

  {#if $graphLoading}
    <div class="overlay">
      <div class="loading-card">
        <span class="spinner" aria-hidden="true"></span>
        <p>Loading codebase graph…</p>
      </div>
    </div>
  {/if}

  {#if $graphError}
    <div class="overlay">
      <div class="error-card">
        <h2>Could not load HyperBase</h2>
        <p>{$graphError}</p>
        <button type="button" on:click={retry}>Retry</button>
      </div>
    </div>
  {/if}

  {#if $graphTruncated && !truncationDismissed}
    <div class="truncation-banner">
      <span>Graph truncated at 300 nodes. Zoom in and search for specific symbols to explore further.</span>
      <button type="button" on:click={() => (truncationDismissed = true)}>Dismiss</button>
    </div>
  {/if}
</div>

<style>
  .app {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: var(--bg-primary);
    position: relative;
  }

  .overlay {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(13, 17, 23, 0.55);
    backdrop-filter: blur(6px);
    z-index: var(--z-modal);
  }

  .loading-card,
  .error-card {
    min-width: 320px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: var(--space-xl);
    text-align: center;
  }

  .loading-card p,
  .error-card p {
    margin: 0;
    color: var(--text-secondary);
  }

  .error-card h2 {
    margin: 0 0 var(--space-sm);
  }

  .error-card button {
    margin-top: var(--space-md);
    border: 0;
    border-radius: var(--radius-md);
    background: var(--text-accent);
    color: var(--bg-primary);
    padding: 10px 14px;
    font-weight: 600;
  }

  .spinner {
    display: inline-block;
    width: 22px;
    height: 22px;
    margin-bottom: var(--space-sm);
    border-radius: 999px;
    border: 3px solid var(--border);
    border-top-color: var(--text-accent);
    animation: spin 0.9s linear infinite;
  }

  .truncation-banner {
    position: fixed;
    top: 92px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: var(--space-md);
    max-width: 760px;
    background: color-mix(in srgb, var(--node-constant) 12%, var(--bg-secondary));
    border: 1px solid color-mix(in srgb, var(--node-constant) 35%, transparent);
    color: var(--node-constant);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    padding: 10px 14px;
    z-index: var(--z-controls);
  }

  .truncation-banner button {
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    padding: 4px 8px;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
