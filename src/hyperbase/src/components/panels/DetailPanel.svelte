<script lang="ts">
  import { activeBranch, graphDepth, loadNeighborhoodGraph } from '../../stores/graph';
  import {
    clearSelectedNode,
    detailLoading,
    selectedNodeData,
    selectedNodeId,
    selectedSymbolDetail,
    selectedSymbolPeek,
    selectNode,
  } from '../../stores/selection';
  import { sidebarOpen } from '../../stores/ui';
  import { shortPath } from '../../lib/graph-utils';

  async function setAsCenter() {
    if (!$selectedNodeId || !$activeBranch || $selectedNodeId.startsWith('file::')) return;

    await loadNeighborhoodGraph($selectedNodeId, {
      branch: $activeBranch,
      depth: $graphDepth,
    });
    await selectNode($selectedNodeId);
  }

  function closePanel() {
    clearSelectedNode();
  }
</script>

<aside class:open={$sidebarOpen} class="detail-panel">
  <div class="panel-header">
    <div>
      <p class="eyebrow">Inspector</p>
      <h2>{$selectedSymbolDetail?.name ?? (($selectedNodeData?.label as string | undefined) ?? 'Node detail')}</h2>
    </div>
    <button class="close-button" type="button" on:click={closePanel}>×</button>
  </div>

  {#if $detailLoading}
    <div class="section">Loading details…</div>
  {:else if $selectedNodeId?.startsWith('file::') && $selectedNodeData}
    <div class="section">
      <div class="kind-badge">file</div>
      <p class="meta-line">{shortPath(String($selectedNodeData.filePath ?? ''))}</p>
      <p class="meta-line">Language: {String($selectedNodeData.language ?? 'unknown')}</p>
      <p class="meta-line">Symbols: {String($selectedNodeData.symbolCount ?? '0')}</p>
      <p class="meta-line">Directory: {String($selectedNodeData.directory ?? '')}</p>
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
      <button class="action-button primary" type="button" on:click={() => void setAsCenter()}>Set as center</button>
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
    color: var(--text-primary);
    font-family: 'SFMono-Regular', ui-monospace, monospace;
    font-size: 12px;
    line-height: 1.55;
    max-height: 300px;
    overflow: auto;
    padding: var(--space-md);
    white-space: pre-wrap;
  }
</style>
