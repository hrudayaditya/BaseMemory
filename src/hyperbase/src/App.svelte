<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import GraphCanvas from './components/canvas/GraphCanvas.svelte';
  import WorkerLayout from './components/canvas/WorkerLayout.svelte';
  import SearchBar from './components/search/SearchBar.svelte';
  import DetailPanel from './components/panels/DetailPanel.svelte';
  import ControlBar from './components/controls/ControlBar.svelte';
  import Minimap from './components/minimap/Minimap.svelte';
  import { readUrlState, writeUrlState } from './lib/url-state';
  import {
    activeBranch,
    focusedSymbolId,
    graphError,
    graphLoading,
    graphTruncated,
    graphDepth,
    initializeGraph,
    retryGraphLoad,
  } from './stores/graph';
  import { selectNode } from './stores/selection';

  let truncationDismissed = false;
  let currentBranch = '';
  let currentFocusedSymbolId: string | null = null;
  let currentDepth = 1;

  const unsubscribers = [
    activeBranch.subscribe((branch) => {
      currentBranch = branch;
      writeUrlState({
        branch,
        symbolId: currentFocusedSymbolId ?? undefined,
        depth: currentDepth,
        view: currentFocusedSymbolId ? 'atom' : 'galaxy',
      });
    }),
    focusedSymbolId.subscribe((symbolId) => {
      currentFocusedSymbolId = symbolId;
      writeUrlState({
        branch: currentBranch,
        symbolId: symbolId ?? undefined,
        depth: currentDepth,
        view: symbolId ? 'atom' : 'galaxy',
      });
    }),
    graphDepth.subscribe((depth) => {
      currentDepth = depth;
      writeUrlState({
        branch: currentBranch,
        symbolId: currentFocusedSymbolId ?? undefined,
        depth,
        view: currentFocusedSymbolId ? 'atom' : 'galaxy',
      });
    }),
  ];

  async function boot() {
    const urlState = readUrlState();
    await initializeGraph(urlState);
    if (urlState.symbolId) {
      await selectNode(urlState.symbolId);
    }
  }

  onMount(() => {
    void boot();
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
        <button type="button" on:click={() => void retryGraphLoad()}>Retry</button>
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
    background: var(--bg-overlay);
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
    background: color-mix(in srgb, var(--node-constant) 14%, var(--bg-secondary));
    border: 1px solid color-mix(in srgb, var(--node-constant) 38%, transparent);
    border-radius: var(--radius-lg);
    padding: 12px 16px;
    color: var(--text-primary);
    z-index: var(--z-search);
    box-shadow: var(--shadow-sm);
  }

  .truncation-banner button {
    border: 0;
    background: transparent;
    color: var(--node-constant);
    font-weight: 600;
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
