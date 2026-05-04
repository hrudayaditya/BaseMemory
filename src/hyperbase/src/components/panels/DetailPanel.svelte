<script lang="ts">
  import { activeBranch, graphDepth, loadBlastRadiusGraph, loadDirectoryGraph, loadNeighborhoodGraph } from '../../stores/graph';
  import { openAnnotationEditor, selectedAnnotation } from '../../lib/annotations';
  import { openGeneratedHandoff } from '../../lib/handoff-actions';
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

  function selectedEntityType(): 'directory' | 'file' | 'symbol' | null {
    const entityType = ($selectedNodeData as { entityType?: unknown } | null)?.entityType;
    return entityType === 'directory' || entityType === 'file' || entityType === 'symbol' ? entityType : null;
  }

  function selectedLabel(): string {
    const nodeData = $selectedNodeData as { label?: unknown; name?: unknown } | null;
    return $selectedSymbolDetail?.name ?? (typeof nodeData?.label === 'string' ? nodeData.label : typeof nodeData?.name === 'string' ? nodeData.name : 'Node detail');
  }

  async function setAsCenter() {
    if (!$selectedNodeId || !$activeBranch || selectedEntityType() !== 'symbol') return;

    await loadNeighborhoodGraph($selectedNodeId, {
      branch: $activeBranch,
      depth: $graphDepth,
    });
    await selectNode($selectedNodeId);
  }

  async function openBlastRadius() {
    if (!$selectedNodeId || !$activeBranch || selectedEntityType() !== 'symbol') return;
    await loadBlastRadiusGraph($selectedNodeId, $activeBranch);
    await selectNode($selectedNodeId);
  }

  async function openDirectory() {
    const filePath = String($selectedNodeData?.filePath ?? '');
    if (!filePath || !$activeBranch) return;
    const normalized = filePath.replace(/\\/g, '/');
    const boundary = normalized.lastIndexOf('/');
    const directoryPath = boundary >= 0 ? normalized.slice(0, boundary) : normalized;
    await loadDirectoryGraph(directoryPath, $activeBranch);
  }

  function closePanel() {
    clearSelectedNode();
  }

  function editAnnotation() {
    if (!$selectedNodeId) return;
    openAnnotationEditor($selectedNodeId, $selectedAnnotation?.note ?? '');
  }
</script>

<aside class:open={$sidebarOpen} class="detail-panel">
  <div class="panel-header">
    <div>
      <p class="eyebrow">Inspector</p>
      <h2>{selectedLabel()}</h2>
    </div>
    <button class="close-button" type="button" on:click={closePanel}>×</button>
  </div>

  {#if $detailLoading}
    <div class="section">Loading details…</div>
  {:else if selectedEntityType() !== 'symbol' && $selectedNodeData}
    <div class="section">
      <div class="kind-badge">{selectedEntityType() ?? 'node'}</div>
      <p class="meta-line">{shortPath(String(($selectedNodeData as { filePath?: unknown })?.filePath ?? ''))}</p>
      <p class="meta-line">Language: {String(($selectedNodeData as { language?: unknown })?.language ?? 'unknown')}</p>
      <p class="meta-line">Symbols: {String(($selectedNodeData as { symbolCount?: unknown })?.symbolCount ?? '0')}</p>
      <p class="meta-line">Directory: {String(($selectedNodeData as { directory?: unknown })?.directory ?? '')}</p>
    </div>
    <div class="section actions">
      <button class="action-button primary" type="button" on:click={() => void openDirectory()}>Open directory</button>
      <button class="action-button" type="button" on:click={editAnnotation}>
        {$selectedAnnotation ? 'Edit note' : 'Add note'}
      </button>
      <button class="action-button" type="button" on:click={() => openGeneratedHandoff([$selectedNodeId!])}>Generate handoff</button>
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
      <button class="action-button blast-hero" type="button" on:click={() => void openBlastRadius()}>Blast Radius</button>
      <button class="action-button primary" type="button" on:click={() => void setAsCenter()}>Set as center</button>
      <button class="action-button" type="button" on:click={editAnnotation}>
        {$selectedAnnotation ? 'Edit note' : 'Add note'}
      </button>
      <button class="action-button" type="button" on:click={() => openGeneratedHandoff([$selectedNodeId!])}>Generate handoff</button>
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

  {#if $selectedAnnotation}
    <div class="section">
      <h3>Note</h3>
      <p class="note-copy">{$selectedAnnotation.note}</p>
      <button class="action-button" type="button" on:click={editAnnotation}>Edit note</button>
    </div>
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
    font-size: 26px;
    line-height: 1.1;
    letter-spacing: -0.02em;
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

  h3 {
    margin: 0 0 10px;
    font-size: 15px;
    line-height: 1.2;
    font-weight: 700;
    letter-spacing: 0.01em;
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
    line-height: 1.55;
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
    font-weight: 600;
  }

  .action-button.primary {
    background: var(--text-accent);
    color: var(--bg-primary);
    border-color: transparent;
  }

  .blast-hero {
    width: 100%;
    justify-content: space-between;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--analytics-blast-depth-1) 82%, transparent),
        color-mix(in srgb, var(--analytics-blast-depth-2) 86%, transparent));
    border-color: transparent;
    color: white;
    box-shadow: 0 16px 32px color-mix(in srgb, var(--analytics-blast-depth-1) 22%, transparent);
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

  .note-copy {
    margin: 0 0 var(--space-md);
    color: var(--text-primary);
    line-height: 1.6;
    white-space: pre-wrap;
  }
</style>
