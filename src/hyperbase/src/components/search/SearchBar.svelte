<script lang="ts">
  import { onDestroy } from 'svelte';
  import { isAbortError, searchSymbols } from '../../api/client';
  import { SEARCH_DEBOUNCE_MS } from '../../lib/constants';
  import { nodeColor, shortPath } from '../../lib/graph-utils';
  import { activeBranch, graphDepth, loadNeighborhoodGraph } from '../../stores/graph';
  import { selectNode } from '../../stores/selection';
  import { searchOpen, searchQuery, searchResults } from '../../stores/ui';
  import type { SearchResult } from '../../types';

  let currentBranch = '';
  let currentDepth = 1;
  let currentQuery = '';
  let currentResults: SearchResult[] = [];
  let highlightedIndex = -1;
  let searchLoading = false;
  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  let searchAbortController: AbortController | null = null;
  let searchRevision = 0;

  const unsubscribers = [
    activeBranch.subscribe((value) => {
      currentBranch = value;
    }),
    graphDepth.subscribe((value) => {
      currentDepth = value;
    }),
    searchQuery.subscribe((value) => {
      currentQuery = value;
    }),
    searchResults.subscribe((value) => {
      currentResults = value;
    }),
  ];

  async function runSearch(query: string) {
    if (!query.trim() || !currentBranch) {
      searchAbortController?.abort();
      searchResults.set([]);
      searchOpen.set(false);
      highlightedIndex = -1;
      return;
    }

    searchAbortController?.abort();
    const abortController = new AbortController();
    searchAbortController = abortController;
    const revision = searchRevision + 1;
    searchRevision = revision;
    searchLoading = true;

    try {
      const results = await searchSymbols(query.trim(), currentBranch, abortController.signal);
      const stillCurrent = searchRevision === revision && !abortController.signal.aborted;
      if (!stillCurrent) {
        return;
      }

      searchResults.set(results.slice(0, 10));
      searchOpen.set(true);
      highlightedIndex = results.length > 0 ? 0 : -1;
    } catch (error) {
      if (!isAbortError(error)) {
        searchResults.set([]);
        searchOpen.set(false);
        highlightedIndex = -1;
      }
    } finally {
      if (searchRevision === revision) {
        searchLoading = false;
      }
    }
  }

  function handleInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    const value = target.value;
    searchQuery.set(value);

    if (debounceHandle) {
      clearTimeout(debounceHandle);
    }

    debounceHandle = setTimeout(() => {
      void runSearch(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  async function selectResult(result: SearchResult) {
    if (!currentBranch) return;
    await loadNeighborhoodGraph(result.id, {
      branch: currentBranch,
      depth: currentDepth,
    });
    await selectNode(result.id);
    searchOpen.set(false);
    searchQuery.set(result.name);
  }

  async function handleKeydown(event: KeyboardEvent) {
    if (!currentResults.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlightedIndex = Math.min(highlightedIndex + 1, currentResults.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlightedIndex = Math.max(highlightedIndex - 1, 0);
    } else if (event.key === 'Enter' && highlightedIndex >= 0) {
      event.preventDefault();
      await selectResult(currentResults[highlightedIndex]);
    } else if (event.key === 'Escape') {
      searchOpen.set(false);
      highlightedIndex = -1;
    }
  }

  onDestroy(() => {
    if (debounceHandle) clearTimeout(debounceHandle);
    searchAbortController?.abort();
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });
</script>

<div class="search-shell">
  <div class="search-wrapper">
    <input
      class="search-input"
      type="text"
      placeholder="Search symbols, functions, files…"
      value={currentQuery}
      on:input={handleInput}
      on:keydown={handleKeydown}
      on:focus={() => searchOpen.set(currentResults.length > 0)}
    />
    {#if searchLoading}
      <span class="spinner" aria-hidden="true"></span>
    {/if}
  </div>

  {#if $searchOpen && currentResults.length > 0}
    <div class="search-results">
      {#each currentResults as result, index}
        <button
          type="button"
          class:selected={index === highlightedIndex}
          class="result-row"
          on:mouseenter={() => (highlightedIndex = index)}
          on:click={() => void selectResult(result)}
        >
          <div class="result-header">
            <span class="result-name">{result.name}</span>
            <span class="kind-badge" style={`background:${nodeColor(result.kind)};`}>{result.kind}</span>
          </div>
          <div class="result-path">{shortPath(result.filePath)}</div>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .search-shell {
    position: fixed;
    top: var(--space-lg);
    left: 50%;
    transform: translateX(-50%);
    width: 480px;
    z-index: var(--z-search);
  }

  .search-wrapper {
    position: relative;
  }

  .search-input {
    width: 100%;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    color: var(--text-primary);
    padding: 14px 44px 14px 16px;
    outline: none;
    box-shadow: var(--shadow-sm);
    transition: border-color var(--transition-fast), transform var(--transition-fast);
  }

  .search-input:focus {
    border-color: var(--border-accent);
    transform: translateY(-1px);
  }

  .spinner {
    position: absolute;
    top: 50%;
    right: var(--space-md);
    width: 16px;
    height: 16px;
    border-radius: 999px;
    border: 2px solid var(--border);
    border-top-color: var(--text-accent);
    transform: translateY(-50%);
    animation: spin 0.8s linear infinite;
  }

  .search-results {
    margin-top: var(--space-sm);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    box-shadow: var(--shadow-lg);
  }

  .result-row {
    width: 100%;
    display: block;
    text-align: left;
    background: transparent;
    border: 0;
    padding: 12px 14px;
    transition: background var(--transition-fast);
  }

  .result-row:hover,
  .result-row.selected {
    background: var(--bg-hover);
  }

  .result-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
  }

  .result-name {
    color: var(--text-primary);
    font-weight: 600;
  }

  .kind-badge {
    border-radius: 999px;
    color: var(--bg-primary);
    font-size: 11px;
    font-weight: 700;
    padding: 3px 8px;
    text-transform: uppercase;
  }

  .result-path {
    margin-top: 4px;
    color: var(--text-muted);
    font-size: 12px;
  }

  @keyframes spin {
    from {
      transform: translateY(-50%) rotate(0deg);
    }
    to {
      transform: translateY(-50%) rotate(360deg);
    }
  }
</style>
