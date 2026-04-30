<script lang="ts">
  import { get } from 'svelte/store';
  import { onDestroy, onMount } from 'svelte';
  import GraphCanvas from './components/canvas/GraphCanvas.svelte';
  import WorkerLayout from './components/canvas/WorkerLayout.svelte';
  import SearchBar from './components/search/SearchBar.svelte';
  import DetailPanel from './components/panels/DetailPanel.svelte';
  import ControlBar from './components/controls/ControlBar.svelte';
  import Minimap from './components/minimap/Minimap.svelte';
  import ShortcutHelpModal from './components/overlays/ShortcutHelpModal.svelte';
  import AnnotationEditorModal from './components/overlays/AnnotationEditorModal.svelte';
import HandoffModal from './components/overlays/HandoffModal.svelte';
import ViewHeader from './components/overlays/ViewHeader.svelte';
import LandingScreen from './components/overlays/LandingScreen.svelte';
  import { OVERLAY_ORDER } from './lib/constants';
  import { readUrlState, writeUrlState } from './lib/url-state';
  import {
    activeBranch,
    currentView,
    currentViewInfo,
    focusedSymbolId,
    graphDepth,
    graphError,
    graphLoading,
    graphTruncated,
    initializeGraph,
    loadBlastRadiusGraph,
    loadGalaxyGraph,
    retryGraphLoad,
    setGraphOverlay,
    showLanding,
    sigmaInstance,
  } from './stores/graph';
  import { clearSelectedNode, selectedNodeData, selectedNodeId, selectNode } from './stores/selection';
  import {
    activeOverlay,
    cancelPathFinding,
    closeSearchDropdown,
    closeHandoffModal,
    focusMode,
    focusedNodeIds,
    pathFindingHint,
    pathFindingMode,
    requestSearchFocus,
    setFocusMode,
    shortcutHelpOpen,
    startPathFinding,
  } from './stores/ui';

  let truncationDismissed = false;
  let urlSyncReady = false;
  let currentBranch = '';
  let currentFocusedSymbolId: string | null = null;
  let currentDepth = 1;
  let currentGraphView = 'overview';
  let currentViewDetails = get(currentViewInfo);
  let currentFocusMode = false;
  let currentFocusedNodeIds = new Set<string>();

  function syncUrlState() {
    if (!urlSyncReady) {
      return;
    }

    const urlView =
      currentViewDetails.kind === 'atom' && currentViewDetails.mode === 'file'
        ? 'file'
        : currentGraphView;

    const pathState =
      currentViewDetails.kind === 'path'
        ? {
            fromId: currentViewDetails.fromId,
            toId: currentViewDetails.toId,
          }
        : {};

    const directoryState =
      currentViewDetails.kind === 'directory'
        ? {
            directoryPath: currentViewDetails.directoryPath,
          }
        : {};

    const fileState =
      currentViewDetails.kind === 'atom' && currentViewDetails.mode === 'file' && currentViewDetails.filePath
        ? {
            filePath: currentViewDetails.filePath,
          }
        : {};

    writeUrlState({
      branch: currentBranch,
      symbolId: currentFocusedSymbolId ?? undefined,
      focus: currentFocusMode && currentFocusedNodeIds.size > 0,
      focusedIds: currentFocusMode && currentFocusedNodeIds.size > 0 ? Array.from(currentFocusedNodeIds) : undefined,
      depth: currentDepth,
      view: urlView,
      ...pathState,
      ...directoryState,
      ...fileState,
    });
  }

  const unsubscribers = [
    activeBranch.subscribe((branch) => {
      currentBranch = branch;
      syncUrlState();
    }),
    focusedSymbolId.subscribe((symbolId) => {
      currentFocusedSymbolId = symbolId;
      syncUrlState();
    }),
    graphDepth.subscribe((depth) => {
      currentDepth = depth;
      syncUrlState();
    }),
    currentView.subscribe((view) => {
      currentGraphView = view;
      truncationDismissed = false;
      syncUrlState();
    }),
    currentViewInfo.subscribe((info) => {
      currentViewDetails = info;
      syncUrlState();
    }),
    focusMode.subscribe((value) => {
      currentFocusMode = value;
      syncUrlState();
    }),
    focusedNodeIds.subscribe((value) => {
      currentFocusedNodeIds = value;
      syncUrlState();
    }),
  ];

  async function boot() {
    const urlState = readUrlState();
    await initializeGraph(urlState);
    if (urlState.view === 'path' && urlState.fromId) {
      await selectNode(urlState.fromId);
    } else if (urlState.symbolId) {
      await selectNode(urlState.symbolId);
    } else if (urlState.filePath) {
      await selectNode(`file::${urlState.filePath}`);
    }
    if (urlState.focus && urlState.focusedIds && urlState.focusedIds.length > 0) {
      setFocusMode(true, urlState.focusedIds);
      if (!urlState.symbolId && !urlState.fromId) {
        await selectNode(urlState.focusedIds[0] ?? null);
      }
    }
    urlSyncReady = true;
    syncUrlState();
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    const element = target instanceof HTMLElement ? target : null;
    if (!element) {
      return false;
    }

    return Boolean(element.closest('input, textarea, select, [contenteditable="true"]'));
  }

  function selectedEntityType(): 'directory' | 'file' | 'symbol' | null {
    const value = get(selectedNodeData) as { entityType?: unknown } | null;
    const entityType = value?.entityType;
    return entityType === 'directory' || entityType === 'file' || entityType === 'symbol' ? entityType : null;
  }

  async function handleKeydown(event: KeyboardEvent) {
    if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
      if (!isEditableTarget(event.target)) {
        event.preventDefault();
        shortcutHelpOpen.set(true);
      }
      return;
    }

    if (event.key === '/') {
      if (!isEditableTarget(event.target)) {
        event.preventDefault();
        requestSearchFocus();
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      shortcutHelpOpen.set(false);
      closeHandoffModal();
      closeSearchDropdown();
      cancelPathFinding();
      setFocusMode(false);
      clearSelectedNode();
      return;
    }

    if (isEditableTarget(event.target)) {
      return;
    }

    if (event.key === ' ') {
      event.preventDefault();
      await get(sigmaInstance)?.getCamera().animatedReset();
      return;
    }

    if (event.key.toLowerCase() === 'g') {
      event.preventDefault();
      await loadGalaxyGraph();
      return;
    }

    if (event.key.toLowerCase() === 'p') {
      event.preventDefault();
      const selectedId = get(selectedNodeId) ?? get(focusedSymbolId);
      if (!selectedId || selectedEntityType() !== 'symbol') {
        pathFindingHint.set('Select a symbol, then press P to choose a path source.');
        return;
      }

      startPathFinding(selectedId);
      pathFindingHint.set('Path mode active. Click a second node to complete the path.');
      return;
    }

    if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      const selectedId = get(selectedNodeId);
      if (!selectedId || selectedEntityType() !== 'symbol') {
        pathFindingHint.set('Select a symbol before opening blast radius.');
        return;
      }

      await loadBlastRadiusGraph(selectedId);
      return;
    }

    if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (get(focusMode)) {
        setFocusMode(false);
        return;
      }

      const selectedId = get(selectedNodeId);
      if (!selectedId) {
        pathFindingHint.set('Select a node before entering focus mode.');
        return;
      }

      setFocusMode(true, [selectedId]);
      return;
    }

    if (event.key.toLowerCase() === 'd') {
      event.preventDefault();
      const currentOverlay = get(activeOverlay);
      const currentIndex = OVERLAY_ORDER.indexOf(currentOverlay);
      const nextOverlay = OVERLAY_ORDER[(currentIndex + 1) % OVERLAY_ORDER.length] ?? 'none';
      setGraphOverlay(nextOverlay);
    }
  }

  onMount(() => {
    void boot();
    document.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeydown);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });
</script>

<div class="app">
  {#if $showLanding}
    <LandingScreen />
  {:else}
    <GraphCanvas />
    <WorkerLayout />
    <SearchBar />
    <ControlBar />
    <ViewHeader />
    <DetailPanel />
    <Minimap />
  {/if}
  <ShortcutHelpModal open={$shortcutHelpOpen} onClose={() => shortcutHelpOpen.set(false)} />
  <AnnotationEditorModal />
  <HandoffModal />

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
      <span>
        {#if $currentView === 'overview'}
          Overview condensed the codebase into readable modules. Open a module or switch to Files view to inspect every file.
        {:else if $currentView === 'galaxy'}
          Graph truncated at 300 nodes. Zoom in and search for specific symbols to explore further.
        {:else if $currentView === 'atom'}
          Neighborhood truncated at 300 nodes. Reduce depth or open connected symbols individually.
        {:else if $currentView === 'blast'}
          Blast radius truncated at 500 nodes. Start from a narrower symbol to inspect the full dependency cone.
        {:else if $currentView === 'directory'}
          Directory view truncated at 10,000 nodes. Narrow the module scope to inspect every connected symbol.
        {:else}
          Graph truncated.
        {/if}
      </span>
      <button type="button" on:click={() => (truncationDismissed = true)}>Dismiss</button>
    </div>
  {/if}

  {#if $pathFindingMode || $pathFindingHint}
    <div class="path-hint">
      {$pathFindingHint ?? 'Path mode active. Click a second node to complete the path.'}
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

  .path-hint {
    position: fixed;
    bottom: 64px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-secondary);
    border: 1px solid var(--border-accent);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    color: var(--text-primary);
    padding: 10px 14px;
    z-index: var(--z-controls);
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
