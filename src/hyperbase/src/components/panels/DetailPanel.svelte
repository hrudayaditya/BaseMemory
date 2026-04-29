<script lang="ts">
  import { fetchNeighborhood, fetchPeek, fetchSymbol } from '../../api/client';
  import { buildNeighborhoodGraphologyInstance, shortPath } from '../../lib/graph-utils';
  import {
    activeBranch,
    focusedSymbolId,
    graphEdgeCount,
    graphInstance,
    graphLoading,
    graphNodeCount,
    graphTruncated,
  } from '../../stores/graph';
  import {
    detailLoading,
    selectedNodeData,
    selectedNodeId,
    selectedSymbolDetail,
    selectedSymbolPeek,
  } from '../../stores/selection';
  import { sidebarOpen } from '../../stores/ui';
  import { graphDepth } from '../../stores/ui';

  let branch = '';
  let depth = 1;
  let selectedId: string | null = null;
  let localNodeData: Record<string, unknown> | null = null;

  activeBranch.subscribe((value) => {
    branch = value;
  });

  graphDepth.subscribe((value) => {
    depth = value;
  });

  selectedNodeData.subscribe((value) => {
    localNodeData = value as Record<string, unknown> | null;
  });

  selectedNodeId.subscribe(async (value) => {
    selectedId = value;
    if (!value) {
      selectedSymbolDetail.set(null);
      selectedSymbolPeek.set(null);
      sidebarOpen.set(false);
      return;
    }

    if (value.startsWith('file::')) {
      selectedSymbolDetail.set(null);
      selectedSymbolPeek.set(null);
      sidebarOpen.set(true);
      return;
    }

    detailLoading.set(true);
    sidebarOpen.set(true);

    try {
      const [detail, peek] = await Promise.all([fetchSymbol(value, branch), fetchPeek(value, branch)]);
      selectedSymbolDetail.set(detail);
      selectedSymbolPeek.set(peek);
    } finally {
      detailLoading.set(false);
    }
  });

  async function setAsCenter() {
    if (!selectedId || !branch || selectedId.startsWith('file::')) return;

    graphLoading.set(true);
    try {
      const neighborhood = await fetchNeighborhood(selectedId, branch, depth);
      const graph = buildNeighborhoodGraphologyInstance(neighborhood.nodes, neighborhood.edges);
      graphInstance.set(graph);
      graphNodeCount.set(neighborhood.nodes.length);
      graphEdgeCount.set(neighborhood.edges.length);
      graphTruncated.set(neighborhood.truncated);
      focusedSymbolId.set(selectedId);
    } finally {
      graphLoading.set(false);
    }
  }

  function closePanel() {
    selectedNodeId.set(null);
  }
</script>

<aside class:open={$sidebarOpen} class="detail-panel">
  <div class="panel-header">
    <div>
      <p class="eyebrow">Inspector</p>
      <h2>{$selectedSymbolDetail?.name ?? (localNodeData?.label as string | undefined) ?? 'Node detail'}</h2>
    </div>
    <button class="close-button" type="button" on:click={closePanel}>×</button>
  </div>

  {#if $detailLoading}
    <div class="section">Loading details…</div>
  {:else if selectedId?.startsWith('file::') && localNodeData}
    <div class="section">
      <div class="kind-badge">file</div>
      <p class="meta-line">{shortPath(String(localNodeData.filePath ?? ''))}</p>
      <p class="meta-line">Language: {String(localNodeData.language ?? 'unknown')}</p>
      <p class="meta-line">Symbols: {String(localNodeData.symbolCount ?? '0')}</p>
      <p class="meta-line">Directory: {String(localNodeData.directory ?? '')}</p>
    </div>
  {:else if $selectedSymbolDetail}
    <div class="section">
      <div class="kind-badge">{$selectedSymbolDetail.kind}</div>
      <p class="meta-line">{$selectedSymbolDetail.filePath}</p>
      <p class="meta-line">
        Lines {$selectedSymbolDetail.startLine}–{$selectedSymbolDetail.endLine} · {$selectedSymbolDetail.language}
      </p>
      <div class="meta-grid">
        <div>
          <span class="label">Callers</span>
          <strong>{$selectedSymbolDetail.callerCount}</strong>
        </div>
        <div>
          <span class="label">Callees</span>
          <strong>{$selectedSymbolDetail.calleeCount}</strong>
        </div>
      </div>
    </div>

    <div class="section actions">
      <button class="action-button primary" type="button" on:click={setAsCenter}>Set as center</button>
      <a
        class="action-button"
        href={`vscode://file/${$selectedSymbolDetail.filePath}:${$selectedSymbolDetail.startLine}`}
      >
        Open in editor
      </a>
    </div>

    <div class="section">
      <h3>Code preview</h3>
      <pre class="code-preview">{$selectedSymbolPeek?.content ?? 'Source unavailable.'}</pre>
    </div>
  {:else}
    <div class="section">Select a symbol to inspect its callers, callees, and source preview.</div>
  {/if}
</aside>

<style>
  .detail-panel {
    position: fixed;
    inset: 0 0 0 auto;
    width: 360px;
    background: var(--bg-secondary);
    border-left: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    transform: translateX(100%);
    transition: transform var(--transition-slow);
    z-index: var(--z-panel);
    display: flex;
    flex-direction: column;
  }

  .detail-panel.open {
    transform: translateX(0);
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: var(--space-lg);
    border-bottom: 1px solid var(--border);
  }

  .eyebrow {
    margin: 0 0 6px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 12px;
  }

  h2 {
    margin: 0;
    font-size: 24px;
    line-height: 1.2;
  }

  .close-button {
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    font-size: 28px;
    line-height: 1;
  }

  .section {
    padding: var(--space-lg);
    border-bottom: 1px solid var(--border);
  }

  .kind-badge {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 4px 10px;
    background: var(--bg-tertiary);
    color: var(--text-accent);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .meta-line {
    color: var(--text-secondary);
    margin: 10px 0 0;
  }

  .meta-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-md);
    margin-top: var(--space-md);
  }

  .label {
    display: block;
    color: var(--text-muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 4px;
  }

  .actions {
    display: flex;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .action-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 10px 14px;
    border-radius: var(--radius-md);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-primary);
  }

  .action-button.primary {
    background: var(--text-accent);
    color: var(--bg-primary);
    border-color: transparent;
  }

  .code-preview {
    margin: var(--space-sm) 0 0;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--space-md);
    max-height: 300px;
    overflow: auto;
    color: var(--text-primary);
    font-size: 12px;
    line-height: 1.5;
  }

  h3 {
    margin: 0;
    font-size: 16px;
  }
</style>
