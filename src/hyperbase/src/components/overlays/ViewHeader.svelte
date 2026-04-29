<script lang="ts">
  import { currentViewInfo, loadGalaxyGraph } from '../../stores/graph';

  async function goToGalaxy() {
    await loadGalaxyGraph();
  }
</script>

{#if $currentViewInfo.kind !== 'galaxy'}
  <div class="view-header">
    <button type="button" class="back-button" on:click={() => void goToGalaxy()}>
      ← Galaxy
    </button>

    <div class="content">
      {#if $currentViewInfo.kind === 'atom'}
        <p class="eyebrow">Neighborhood</p>
        <h2>{$currentViewInfo.symbolName}</h2>
      {:else if $currentViewInfo.kind === 'blast'}
        <p class="eyebrow">Blast Radius</p>
        <h2>Blast radius of {$currentViewInfo.symbolName}</h2>
      {:else if $currentViewInfo.kind === 'path'}
        <p class="eyebrow">Path Finder</p>
        {#if $currentViewInfo.found}
          <h2>Path: {$currentViewInfo.fromName} → {$currentViewInfo.toName}</h2>
          <p class="meta">{$currentViewInfo.hopCount} hops</p>
        {:else if $currentViewInfo.exhausted}
          <h2>Search exhausted before finding a path</h2>
          <p class="meta">Tried to connect {$currentViewInfo.fromName} → {$currentViewInfo.toName}</p>
        {:else}
          <h2>No call path found</h2>
          <p class="meta">{$currentViewInfo.fromName} → {$currentViewInfo.toName}</p>
        {/if}
      {:else if $currentViewInfo.kind === 'directory'}
        <p class="eyebrow">Directory View</p>
        <h2>{$currentViewInfo.directoryPath}</h2>
      {/if}
    </div>
  </div>
{/if}

<style>
  .view-header {
    position: fixed;
    top: var(--space-lg);
    left: var(--space-lg);
    display: flex;
    align-items: flex-start;
    gap: var(--space-md);
    z-index: var(--z-controls);
    max-width: min(640px, calc(100vw - 440px));
  }

  .back-button,
  .content {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
  }

  .back-button {
    color: var(--text-primary);
    padding: 10px 14px;
  }

  .content {
    padding: 14px 16px;
  }

  .eyebrow,
  .meta {
    margin: 0;
    color: var(--text-secondary);
  }

  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 12px;
    margin-bottom: 4px;
  }

  .meta {
    margin-top: 4px;
    font-size: 13px;
  }

  h2 {
    margin: 0;
    font-size: 20px;
    line-height: 1.2;
    color: var(--text-primary);
    word-break: break-word;
  }
</style>
