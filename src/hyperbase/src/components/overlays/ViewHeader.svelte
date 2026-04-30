<script lang="ts">
  import { get } from 'svelte/store';
  import { currentViewInfo, loadDirectoryGraph, loadFileGraph, loadGalaxyGraph, loadOverviewGraph, sigmaInstance } from '../../stores/graph';

  type Breadcrumb = {
    label: string;
    action?: () => Promise<void>;
  };

  function shortLabel(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).slice(-1)[0] ?? normalized;
  }

  function animateOutAndRun(action: () => Promise<void>) {
    const sigma = get(sigmaInstance);
    const camera = sigma?.getCamera();
    if (!camera) {
      void action();
      return;
    }

    camera.animate(
      { ratio: Math.min(camera.ratio * 1.65, 3.2) },
      { duration: 260 },
      () => {
        void action();
      }
    );
  }

  function breadcrumbsForView(): Breadcrumb[] {
    const info = get(currentViewInfo);

    if (info.kind === 'overview' || info.kind === 'galaxy') {
      return [];
    }

    if (info.kind === 'directory') {
      return [
        { label: 'Overview', action: () => loadOverviewGraph() },
        { label: shortLabel(info.directoryPath) },
      ];
    }

    if (info.kind === 'atom' && info.mode === 'file' && info.filePath) {
      return [
        { label: 'Overview', action: () => loadOverviewGraph() },
        info.directoryPath ? { label: shortLabel(info.directoryPath), action: () => loadDirectoryGraph(info.directoryPath!) } : null,
        { label: shortLabel(info.filePath) },
      ].filter(Boolean) as Breadcrumb[];
    }

    if (info.kind === 'atom' && info.mode === 'symbol') {
      const directoryPath = info.filePath?.replace(/\\/g, '/').split('/').slice(0, -1).join('/') ?? undefined;
      return [
        { label: 'Overview', action: () => loadOverviewGraph() },
        directoryPath ? { label: shortLabel(directoryPath), action: () => loadDirectoryGraph(directoryPath) } : null,
        info.filePath ? { label: shortLabel(info.filePath), action: () => loadFileGraph(info.filePath!) } : null,
        { label: info.symbolName ?? 'Symbol' },
      ].filter(Boolean) as Breadcrumb[];
    }

    if (info.kind === 'blast') {
      return [
        { label: 'Overview', action: () => loadOverviewGraph() },
        { label: `Blast Radius` },
      ];
    }

    if (info.kind === 'path') {
      return [
        { label: 'Overview', action: () => loadOverviewGraph() },
        { label: 'Path Finder' },
      ];
    }

    return [];
  }
</script>

{#if $currentViewInfo.kind !== 'overview'}
  <div class="view-header">
    <div class="content">
      <nav class="breadcrumbs" aria-label="Graph hierarchy">
        {#each breadcrumbsForView() as crumb, index}
          {#if crumb.action}
            <button type="button" class="crumb-button" on:click={() => animateOutAndRun(crumb.action!)}>
              {crumb.label}
            </button>
          {:else}
            <span class="crumb-current">{crumb.label}</span>
          {/if}
          {#if index < breadcrumbsForView().length - 1}
            <span class="crumb-separator">›</span>
          {/if}
        {/each}
      </nav>

      {#if $currentViewInfo.kind === 'galaxy'}
        <p class="eyebrow">Files View</p>
        <h2>Full file graph</h2>
      {:else if $currentViewInfo.kind === 'atom' && $currentViewInfo.mode === 'file'}
        <p class="eyebrow">Symbol View</p>
        <h2>{$currentViewInfo.filePath}</h2>
      {:else if $currentViewInfo.kind === 'atom'}
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
        <p class="eyebrow">Module View</p>
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
    max-width: min(720px, calc(100vw - 440px));
  }

  .content {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 20px;
    box-shadow: var(--shadow-sm);
    padding: 16px 18px;
  }

  .breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin-bottom: 8px;
  }

  .crumb-button,
  .crumb-current {
    font-size: 13px;
    line-height: 1.3;
  }

  .crumb-button {
    border: 0;
    background: transparent;
    color: var(--text-accent);
    padding: 0;
    font-weight: 600;
  }

  .crumb-current {
    color: var(--text-primary);
  }

  .crumb-separator,
  .eyebrow,
  .meta {
    color: var(--text-secondary);
  }

  .eyebrow {
    margin: 0 0 4px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 11px;
    font-weight: 700;
  }

  .meta {
    margin: 4px 0 0;
    font-size: 13px;
  }

  h2 {
    margin: 0;
    font-size: 24px;
    line-height: 1.1;
    letter-spacing: -0.02em;
    color: var(--text-primary);
    word-break: break-word;
  }
</style>
