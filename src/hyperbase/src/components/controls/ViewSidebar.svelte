<script lang="ts">
  import {
    activeBranch,
    availableBranches,
    changeActiveBranch,
    currentGraphPayload,
    demoRepos,
    graphStats,
    loadFullSymbolGraph,
    loadGalaxyGraph,
    loadOverviewGraph,
    selectDemoGraph,
    sigmaInstance,
    uploadDatabaseGraph,
  } from '../../stores/graph';

  let settingsOpen = false;
  let activeMode: 'folders' | 'files' | 'functions' = 'folders';
  let uploadInput: HTMLInputElement | null = null;

  $: {
    if ($currentGraphPayload?.kind === 'full-symbol') {
      activeMode = 'functions';
    } else if ($currentGraphPayload?.kind === 'galaxy') {
      activeMode = 'files';
    } else {
      activeMode = 'folders';
    }
  }

  function animateAndRun(action: () => Promise<void>) {
    const sigma = $sigmaInstance;
    const camera = sigma?.getCamera();
    if (!camera) {
      void action();
      return;
    }

    camera.animate({ ratio: Math.min(camera.ratio * 1.2, 2.4) }, { duration: 220 }, () => {
      void action();
    });
  }

  function openUploadPicker() {
    uploadInput?.click();
  }

  async function handleFilePick(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await uploadDatabaseGraph(file);
    input.value = '';
    settingsOpen = false;
  }

  async function chooseDemoRepo(demoId: string) {
    await selectDemoGraph(demoId);
    settingsOpen = false;
  }
</script>

<aside class="sidebar">
  <div class="brand">
    <div class="logo">H</div>
    <div class="wordmark">HyperBase</div>
  </div>

  <nav class="modes" aria-label="Graph views">
    <button
      type="button"
      class:active={activeMode === 'folders'}
      class="mode-button"
      on:click={() => animateAndRun(() => loadOverviewGraph())}
      title="Folders view"
    >
      <span class="mode-icon">▣</span>
      <span class="mode-label">Folders</span>
    </button>
    <button
      type="button"
      class:active={activeMode === 'files'}
      class="mode-button"
      on:click={() => animateAndRun(() => loadGalaxyGraph())}
      title="Files view"
    >
      <span class="mode-icon">☷</span>
      <span class="mode-label">Files</span>
    </button>
    <button
      type="button"
      class:active={activeMode === 'functions'}
      class="mode-button"
      on:click={() => animateAndRun(() => loadFullSymbolGraph())}
      title="Functions view"
    >
      <span class="mode-icon">◌</span>
      <span class="mode-label">Functions</span>
    </button>
  </nav>

  <div class="stats">
    <span>{$graphStats.nodeCount}</span>
    <small>nodes</small>
    <span>{$graphStats.edgeCount}</span>
    <small>edges</small>
  </div>

  <div class="settings">
    <button type="button" class="settings-button" on:click={() => (settingsOpen = !settingsOpen)} title="Settings">
      ⚙
    </button>

    {#if settingsOpen}
      <div class="settings-popover">
        <label for="sidebar-branch">Branch</label>
        <select
          id="sidebar-branch"
          value={$activeBranch}
          on:change={(event) => void changeActiveBranch((event.currentTarget as HTMLSelectElement).value)}
        >
          {#each $availableBranches as branch}
            <option value={branch}>{branch}</option>
          {/each}
        </select>

        <div class="settings-divider"></div>

        <span class="section-label">Switch codebase</span>
        <button type="button" class="db-button" on:click={openUploadPicker}>Upload `codebase.db`</button>
        <input bind:this={uploadInput} class="hidden-input" type="file" accept=".db" on:change={(event) => void handleFilePick(event)} />

        {#if $demoRepos.length > 0}
          <div class="demo-list">
            {#each $demoRepos as demo}
              <button type="button" class="demo-chip" on:click={() => void chooseDemoRepo(demo.id)}>
                <strong>{demo.name}</strong>
                <span>{demo.symbolCount} symbols</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</aside>

<style>
  .sidebar {
    position: fixed;
    top: 14px;
    left: 14px;
    bottom: 14px;
    width: 72px;
    padding: 14px 10px;
    border: 1px solid var(--border);
    border-radius: 24px;
    background: color-mix(in srgb, var(--bg-secondary) 92%, transparent);
    backdrop-filter: blur(14px);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    z-index: var(--z-controls);
  }

  .brand {
    display: grid;
    justify-items: center;
    gap: 8px;
  }

  .logo {
    width: 38px;
    height: 38px;
    border-radius: 14px;
    display: grid;
    place-items: center;
    background: linear-gradient(135deg, var(--text-accent), color-mix(in srgb, var(--text-accent) 45%, white));
    color: var(--bg-primary);
    font-weight: 800;
    letter-spacing: -0.03em;
  }

  .wordmark {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-secondary);
    font-weight: 700;
  }

  .modes {
    display: grid;
    gap: 10px;
    width: 100%;
  }

  .mode-button {
    border: 1px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: 18px;
    min-height: 60px;
    display: grid;
    justify-items: center;
    align-content: center;
    gap: 4px;
    padding: 8px 6px;
  }

  .mode-button.active {
    border-color: var(--border-accent);
    color: var(--text-accent);
    background: color-mix(in srgb, var(--text-accent) 14%, var(--bg-tertiary));
  }

  .mode-icon {
    font-size: 18px;
    line-height: 1;
  }

  .mode-label {
    font-size: 10px;
    line-height: 1.1;
    font-weight: 700;
  }

  .stats {
    margin-top: auto;
    display: grid;
    justify-items: center;
    gap: 2px;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 700;
  }

  .stats small {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-secondary);
  }

  .settings {
    position: relative;
  }

  .settings-button {
    width: 40px;
    height: 40px;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .settings-popover {
    position: absolute;
    left: 52px;
    bottom: 0;
    min-width: 240px;
    padding: 14px;
    border-radius: 18px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    box-shadow: var(--shadow-lg);
    display: grid;
    gap: 8px;
  }

  .settings-popover label {
    color: var(--text-secondary);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
  }

  .section-label {
    color: var(--text-secondary);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
  }

  .settings-popover select {
    width: 100%;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-primary);
    border-radius: 12px;
    padding: 10px 12px;
  }

  .settings-divider {
    height: 1px;
    background: var(--border);
    margin: 2px 0;
  }

  .db-button,
  .demo-chip {
    width: 100%;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    padding: 10px 12px;
    text-align: left;
  }

  .demo-list {
    display: grid;
    gap: 8px;
  }

  .demo-chip {
    display: grid;
    gap: 2px;
  }

  .demo-chip strong {
    font-size: 12px;
    line-height: 1.2;
  }

  .demo-chip span {
    font-size: 11px;
    line-height: 1.2;
    color: var(--text-secondary);
  }

  .hidden-input {
    display: none;
  }
</style>
