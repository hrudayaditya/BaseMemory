<script lang="ts">
  import {
    activeBranch,
    availableBranches,
    changeActiveBranch,
    changeGraphDepth,
    graphDepth,
    graphStats,
    graphTruncated,
    setGraphOverlay,
  } from '../../stores/graph';
  import { activeOverlay } from '../../stores/ui';

  const depthOptions = [1, 2, 3];
  const overlays = [
    { key: 'none', label: 'None' },
    { key: 'community', label: 'Community' },
    { key: 'degree', label: 'Degree' },
    { key: 'language', label: 'Language' },
  ] as const;
</script>

<div class="control-bar">
  <div class="group">
    <label for="branch-select">Branch</label>
    <select
      id="branch-select"
      value={$activeBranch}
      on:change={(event) => void changeActiveBranch((event.currentTarget as HTMLSelectElement).value)}
    >
      {#each $availableBranches as branch}
        <option value={branch}>{branch}</option>
      {/each}
    </select>
  </div>

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
      {#each overlays as overlay}
        <button
          type="button"
          class:active={$activeOverlay === overlay.key}
          class="pill"
          on:click={() => setGraphOverlay(overlay.key)}
        >
          {overlay.label}
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

  label,
  span {
    color: var(--text-secondary);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  select {
    width: 100%;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-primary);
    border-radius: var(--radius-md);
    padding: 10px 12px;
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
</style>
