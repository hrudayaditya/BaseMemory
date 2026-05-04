<script lang="ts">
  import { get } from 'svelte/store';
  import {
    currentGraphPayload,
    changeGraphDepth,
    graphInstance,
    graphDepth,
    graphStats,
    graphTruncated,
    setGraphOverlay,
    sigmaInstance,
  } from '../../stores/graph';
  import { activeOverlay } from '../../stores/ui';
  import { OVERLAY_ORDER } from '../../lib/constants';
  import { exportCanvasPng, exportGraphJson, exportVisibleGraphSvg } from '../../lib/export';
  import { openGeneratedHandoff } from '../../lib/handoff-actions';

  const depthOptions = [1, 2, 3];
  const overlayLabels: Record<(typeof OVERLAY_ORDER)[number], string> = {
    none: 'None',
    community: 'Community',
    degree: 'Degree',
    language: 'Language',
    coupling: 'Coupling',
    dead: 'Dead Code',
    hotspot: 'Hotspots',
  };

  let exportOpen = false;

  async function exportPng() {
    const sigma = get(sigmaInstance);
    if (!sigma) return;
    exportOpen = false;
    await exportCanvasPng(sigma);
  }

  function exportSvg() {
    const sigma = get(sigmaInstance);
    const graph = get(graphInstance);
    if (!sigma || !graph) return;
    exportOpen = false;
    exportVisibleGraphSvg(sigma, graph);
  }

  function exportJson() {
    const payload = get(currentGraphPayload);
    if (!payload) return;
    exportOpen = false;
    exportGraphJson(payload);
  }
</script>

<div class="control-bar">
  <div class="group">
    <span>Depth</span>
    <div class="pills">
      {#each depthOptions as option}
        <button
          type="button"
          class:active={$graphDepth === option}
          class="pill"
          on:click={() => void changeGraphDepth(option)}
        >
          {option}
        </button>
      {/each}
    </div>
  </div>

  <div class="group">
    <span>Overlay</span>
    <div class="pills">
      {#each OVERLAY_ORDER as overlay}
        <button
          type="button"
          class:active={$activeOverlay === overlay}
          class="pill"
          on:click={() => setGraphOverlay(overlay)}
        >
          {overlayLabels[overlay]}
        </button>
      {/each}
    </div>
  </div>

  <div class="stats">
    <span>{$graphStats.nodeCount} nodes</span>
    <span>{$graphStats.edgeCount} edges</span>
  </div>

  {#if $graphTruncated}
    <div class="warning">Graph truncated</div>
  {/if}

  <div class="actions">
    <button type="button" class="action-button" on:click={() => openGeneratedHandoff()}>Generate Handoff</button>

    <div class="export-menu">
      <button type="button" class="action-button" on:click={() => (exportOpen = !exportOpen)}>
        Export
      </button>

      {#if exportOpen}
        <div class="export-popover">
          <button type="button" on:click={() => void exportPng()}>PNG</button>
          <button type="button" on:click={exportSvg}>SVG</button>
          <button type="button" on:click={exportJson}>JSON</button>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .control-bar {
    position: fixed;
    top: var(--space-lg);
    right: var(--space-lg);
    width: 320px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-md);
    z-index: var(--z-controls);
    display: grid;
    gap: var(--space-md);
  }

  .group {
    display: grid;
    gap: var(--space-sm);
  }

  span {
    color: var(--text-secondary);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .pills {
    display: flex;
    gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .pill {
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    padding: 8px 12px;
  }

  .pill.active {
    border-color: var(--border-accent);
    color: var(--text-accent);
  }

  .stats {
    display: flex;
    gap: var(--space-md);
    color: var(--text-primary);
    font-size: 13px;
  }

  .warning {
    border-radius: var(--radius-md);
    padding: 10px 12px;
    background: color-mix(in srgb, var(--node-constant) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--node-constant) 40%, transparent);
    color: var(--node-constant);
    font-size: 12px;
    font-weight: 600;
  }

  .actions {
    display: flex;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .action-button {
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    padding: 10px 12px;
  }

  .export-menu {
    position: relative;
  }

  .export-popover {
    position: absolute;
    top: calc(100% + var(--space-xs));
    right: 0;
    min-width: 140px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    padding: var(--space-xs);
    display: grid;
    gap: var(--space-xs);
    z-index: calc(var(--z-controls) + 1);
  }

  .export-popover button {
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-primary);
    padding: 9px 10px;
    text-align: left;
  }

  .export-popover button:hover {
    background: var(--bg-hover);
  }
</style>
