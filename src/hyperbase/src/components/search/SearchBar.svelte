<script lang="ts">
  import { get } from 'svelte/store';
  import { onDestroy } from 'svelte';
  import { isAbortError, searchSymbols } from '../../api/client';
  import { SEARCH_DEBOUNCE_MS } from '../../lib/constants';
  import { nodeColor, shortPath } from '../../lib/graph-utils';
  import { activeBranch, currentView, graphDepth, graphInstance, loadDirectoryGraph, loadNeighborhoodGraph } from '../../stores/graph';
  import { selectNode } from '../../stores/selection';
  import { requestCinematicFocus, searchFocusNonce, searchOpen, searchQuery, searchResults } from '../../stores/ui';
  import type { SearchResult } from '../../types';

  let inputElement: HTMLInputElement;
  let currentBranch = '';
  let currentDepth = 1;
  let currentViewKind = 'overview';
  let currentQuery = '';
  let currentResults: SearchResult[] = [];
  let highlightedIndex = -1;
  let searchLoading = false;
  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  let searchAbortController: AbortController | null = null;
  let searchRevision = 0;
  let hasSearched = false;

  const unsubscribers = [
    activeBranch.subscribe((value) => { currentBranch = value; }),
    graphDepth.subscribe((value) => { currentDepth = value; }),
    currentView.subscribe((value) => { currentViewKind = value; }),
    searchQuery.subscribe((value) => { currentQuery = value; }),
    searchResults.subscribe((value) => { currentResults = value; }),
    searchFocusNonce.subscribe(() => {
      inputElement?.focus();
      inputElement?.select();
    }),
  ];

  async function runSearch(query: string) {
    if (!query.trim() || !currentBranch) {
      searchAbortController?.abort();
      searchResults.set([]);
      searchOpen.set(false);
      highlightedIndex = -1;
      hasSearched = false;
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
      if (!stillCurrent) return;

      searchResults.set(results.slice(0, 10));
      searchOpen.set(true);
      highlightedIndex = results.length > 0 ? 0 : -1;
      hasSearched = true;
    } catch (error) {
      if (!isAbortError(error)) {
        searchResults.set([]);
        searchOpen.set(false);
        highlightedIndex = -1;
      }
    } finally {
      if (searchRevision === revision) searchLoading = false;
    }
  }

  function handleInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    const value = target.value;
    searchQuery.set(value);
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => { void runSearch(value); }, SEARCH_DEBOUNCE_MS);
  }

  async function selectResult(result: SearchResult) {
    if (!currentBranch) return;
    const graph = get(graphInstance);
    const canSelectInPlace = currentViewKind === 'functions' && graph?.hasNode(result.id);
    const focusRatio = currentViewKind === 'functions' ? 1.9 : 1.65;
    if (canSelectInPlace) {
      requestCinematicFocus(result.id, 'search', focusRatio);
      const nextNodeData = graph ? (graph.getNodeAttributes(result.id) as unknown as Record<string, unknown>) : null;
      await selectNode(result.id, nextNodeData);
    } else {
      requestCinematicFocus(result.id, 'search', focusRatio);
      await loadNeighborhoodGraph(result.id, { branch: currentBranch, depth: currentDepth });
      await selectNode(result.id);
    }
    searchOpen.set(false);
    searchQuery.set(result.name);
  }

  async function openResultDirectory(result: SearchResult, event: MouseEvent) {
    event.stopPropagation();
    if (!currentBranch) return;
    const normalized = result.filePath.replace(/\\/g, '/');
    const boundary = normalized.lastIndexOf('/');
    const directoryPath = boundary >= 0 ? normalized.slice(0, boundary) : normalized;
    await loadDirectoryGraph(directoryPath, currentBranch);
    searchOpen.set(false);
    searchQuery.set(result.name);
  }

  function clearSearch() {
    searchQuery.set('');
    searchResults.set([]);
    searchOpen.set(false);
    highlightedIndex = -1;
    hasSearched = false;
    inputElement?.focus();
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

  $: showPanel = $searchOpen && (currentResults.length > 0 || (hasSearched && currentQuery.trim().length > 0 && !searchLoading));
  $: isEmptyState = hasSearched && currentResults.length === 0 && currentQuery.trim().length > 0 && !searchLoading;

  onDestroy(() => {
    if (debounceHandle) clearTimeout(debounceHandle);
    searchAbortController?.abort();
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });
</script>

<div class="search-shell" class:expanded={showPanel}>
  <div class="glass-card" class:has-panel={showPanel}>
    <div class="search-wrapper">
      <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>

      <input
        class="search-input"
        type="text"
        placeholder="Type a command or search"
        value={currentQuery}
        on:input={handleInput}
        on:keydown={handleKeydown}
        on:focus={() => searchOpen.set(currentResults.length > 0 || hasSearched)}
        bind:this={inputElement}
      />

      {#if searchLoading}
        <span class="spinner" aria-hidden="true"></span>
      {/if}

      <span class="kbd-hint" aria-hidden="true">
        <kbd>/</kbd>
      </span>
    </div>

    {#if showPanel}
      <div class="panel">
        {#if currentResults.length > 0}
          <div class="search-results">
            {#each currentResults as result, index}
              <div
                role="button"
                tabindex="0"
                class:selected={index === highlightedIndex}
                class="result-row"
                on:mouseenter={() => (highlightedIndex = index)}
                on:click={() => void selectResult(result)}
                on:keydown={(event) => event.key === 'Enter' && void selectResult(result)}
              >
                <div class="result-header">
                  <span class="result-name">{result.name}</span>
                  <span class="kind-badge" style={`background:${nodeColor(result.kind)};`}>{result.kind}</span>
                </div>
                <div class="result-footer">
                  <div class="result-path">{shortPath(result.filePath)}</div>
                  <button class="directory-link" type="button" on:click={(event) => void openResultDirectory(result, event)}>
                    Open<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-folder" viewBox="0 0 16 16">
                          <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3h3.982a2 2 0 0 1 1.992 2.181l-.637 7A2 2 0 0 1 13.174 14H2.826a2 2 0 0 1-1.991-1.819l-.637-7a2 2 0 0 1 .342-1.31zM2.19 4a1 1 0 0 0-.996 1.09l.637 7a1 1 0 0 0 .995.91h10.348a1 1 0 0 0 .995-.91l.637-7A1 1 0 0 0 13.81 4zm4.69-1.707A1 1 0 0 0 6.172 2H2.5a1 1 0 0 0-1 .981l.006.139q.323-.119.684-.12h5.396z"/>
                        </svg>
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {:else if isEmptyState}
          <div class="empty-state">
            <div class="empty-radar" aria-hidden="true">
              <span class="ring ring-1"></span>
              <span class="ring ring-2"></span>
              <span class="ring ring-3"></span>
              <div class="empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
              </div>
            </div>
            <h3 class="empty-title">No results found</h3>
            <p class="empty-desc">
              &ldquo;{currentQuery}&rdquo; didn&rsquo;t match any symbols, functions, or files. 
              Try a different query.
            </p>
            <button class="clear-btn" type="button" on:click={clearSearch}>Clear search</button>
          </div>
        {/if}

        <div class="footer-bar">
          <div class="hint">
            <span class="key-pill">↑</span>
            <span class="key-pill">↓</span>
            <span class="hint-label">navigate</span>
          </div>
          <div class="hint">
            <span class="key-pill">↵</span>
            <span class="hint-label">open</span>
          </div>
          <div class="hint">
            <span class="key-pill">esc</span>
            <span class="hint-label">close</span>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .search-shell {
    position: fixed;
    top: var(--space-lg);
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, calc(100vw - var(--space-lg) * 2));
    z-index: var(--z-search);
  }

  /* Refined glass — softer, more in-tune with a dark editor theme.
     Uses a thin hairline + subtle gradient fill instead of heavy blur. */
  .glass-card {
    position: relative;
    background:
      linear-gradient(
        180deg,
        color-mix(in oklab, var(--bg-secondary) 78%, transparent) 0%,
        color-mix(in oklab, var(--bg-secondary) 70%, transparent) 100%
      );
    backdrop-filter: blur(20px) saturate(140%);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
    border: 6px solid rgba(170, 212, 255, 0.1);
    border-radius: 14px;
    box-shadow:
      0 0px 0 0 color-mix(in oklab, white 6%, transparent) inset,
      0 18px 50px -22px rgba(0, 0, 0, 0.55),
      0 2px 8px -2px rgba(0, 0, 0, 0.35);
    transition: border-color 160ms ease, box-shadow 200ms ease;
  }

  /* .glass-card:focus-within {
    border-color: color-mix(in oklab, var(--border-accent, var(--border)) 80%, transparent);
    box-shadow:
      0 0px 0 0 color-mix(in oklab, white 8%, transparent) inset,
      0 0 0 3px color-mix(in oklab, var(--text-accent) 14%, transparent),
      0 22px 60px -22px rgba(0, 0, 0, 0.6);
  } */

  /* The header row.
     KEY FIX: align-items: center with NO height: 100% on the input —
     the icon, text and pill now share the same baseline (no 1px drift). */
  .search-wrapper {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px;
    height: 52px;
  }

  .search-icon {
    width: 16px;
    height: 16px;
    color: #ffffff80;
    flex-shrink: 0;
    /* Optical balance: nudge down 0.5px so the glyph centers with cap-height */
    transform: translateY(0.5px);
  }

  .search-input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 0;
    outline: none;
    padding: 0;
    margin: 0;
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1;          /* prevents the input from imposing its own taller line-box */
    font-family: inherit;
    letter-spacing: 0.01em;
  }

  .search-input::placeholder {
    color: #ffffffc0;
  }

  .spinner {
    width: 13px;
    height: 13px;
    border-radius: 999px;
    border: 1.5px solid color-mix(in oklab, var(--border) 70%, transparent);
    border-top-color: var(--text-accent);
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  /* Keyboard hint — quieter and properly aligned with the row. */
  .kbd-hint {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }

  .kbd-hint kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 20px;
    padding: 0 5px;
    border-radius: 5px;
    border: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
    background: color-mix(in oklab, var(--bg-primary) 60%, transparent);
    color: #ffffffa0;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
  }

  /* SEAMLESS DIVIDER — the previous version had border-top here while the
     glass-card also had its own border + shadow inset, which produced a
     ~1px visible seam. We use a single hairline via a pseudo-element so it
     sits flush against the rounded corners. */
  .panel {
    position: relative;
    animation: fade-in 200ms ease;
  }

  .panel::before {
    content: '';
    position: absolute;
    top: 0;
    left: 12px;
    right: 12px;
    height: 1px;
    background: color-mix(in oklab, var(--border) 85%, transparent);
  }

  .search-results {
    max-height: 380px;
    overflow-y: auto;
    padding: 8px 6px;
  }

  .result-row {
    display: block;
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 10px;
    padding: 10px 12px;
    transition: background 140ms ease;
    cursor: pointer;
    animation: fade-up 200ms ease both;
  }

  .result-row:hover,
  .result-row.selected {
    background: color-mix(in oklab, var(--bg-hover) 70%, transparent);
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
    font-size: 13.5px;
  }

  .kind-badge {
    border-radius: 999px;
    color: var(--bg-primary);
    font-size: 10px;
    font-weight: 700;
    padding: 3px 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .result-footer {
    margin-top: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
  }

  .result-path {
    color: var(--text-muted);
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, monospace;
  }

  .directory-link {
    border: 0;
    background: transparent;
    color: rgb(173 222 255 / 69%);
    font-size: 12px;
    padding: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
  }

  .bi-folder {
    width: 13px;
    height: 13px;
    display: block; 
  }

  .directory-link:hover { text-decoration: underline; }

  /* Empty state */
  .empty-state {
    padding: 40px 24px 28px;
    text-align: center;
    animation: fade-in 240ms ease;
  }

  .empty-radar {
    position: relative;
    width: 140px;
    height: 110px;
    margin: 0 auto 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .empty-radar .ring {
    position: absolute;
    top: 50%;
    left: 50%;
    border-radius: 999px;
    border: 1px solid color-mix(in oklab, var(--border) 75%, transparent);
    transform: translate(-50%, -50%);
  }

  .ring-1 { width: 80px; height: 80px; opacity: 0.9; }
  .ring-2 { width: 125px; height: 125px; opacity: 0.65; }
  .ring-3 { width: 180px; height: 180px; opacity: 0.5; }

  .empty-icon {
    position: relative;
    width: 40px;
    height: 40px;
    border-radius: 11px;
    border: 1px solid color-mix(in oklab, var(--border) 65%, transparent);
    background: color-mix(in oklab, var(--bg-primary) 50%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    color: color-mix(in oklab, var(--text-primary) 80%, transparent);
  }

  .empty-icon svg { width: 20px; height: 20px; color: #ffffffda; }

  .empty-title {
    margin: 0 0 6px;
    color: var(--text-primary);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .empty-desc {
    margin: 0 auto 18px;
    color: var(--text-muted);
    font-size: 13px;
    max-width: 340px;
    line-height: 1.55;
  }

  .clear-btn {
    background: transparent;
    color: var(--text-primary);
    border: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
    border-radius: 9px;
    padding: 7px 18px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 140ms ease, border-color 140ms ease;
  }

  .clear-btn:hover {
    background: color-mix(in oklab, var(--bg-hover) 60%, transparent);
    border-color: color-mix(in oklab, var(--border) 95%, transparent);
  }

  /* Footer hint bar — same hairline trick to avoid the double-border seam. */
  .footer-bar {
    position: relative;
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 9px 14px;
    background: color-mix(in oklab, var(--bg-primary) 22%, transparent);
    border-bottom-left-radius: 13px;
    border-bottom-right-radius: 13px;
  }

  .footer-bar::before {
    content: '';
    position: absolute;
    top: 0;
    left: 12px;
    right: 12px;
    height: 1px;
    background: color-mix(in oklab, var(--border) 85%, transparent);
  }

  .hint {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .key-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border-radius: 5px;
    border: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
    background: color-mix(in oklab, var(--bg-primary) 55%, transparent);
    color: var(--text-primary);
    font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, monospace;
    line-height: 1;
  }

  .hint-label {
    color: var(--text-muted);
    font-size: 12px;
  }

  @keyframes fade-in {
    from { opacity: 0; transform: translateY(-3px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes fade-up {
    from { opacity: 0; transform: translateY(3px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
</style>
