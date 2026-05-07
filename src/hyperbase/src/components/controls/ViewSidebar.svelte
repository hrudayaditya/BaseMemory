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

  let activeMode: 'folders' | 'files' | 'functions' = 'folders';
  let uploadInput: HTMLInputElement | null = null;

  // Expand / collapse state
  let expanded = false;

  // Per-section open state (only meaningful when expanded)
  let viewsOpen = true;
  let statsOpen = true;
  let codebaseOpen = true;

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
  }

  async function chooseDemoRepo(demoId: string) {
    await selectDemoGraph(demoId);
  }

  function toggleExpanded() {
    expanded = !expanded;
  }
</script>

<aside class="sidebar" class:expanded>
  <!-- ===== Header ===== -->
  <div class="header">
    <div class="brand">
      <div class="logo">H</div>
      {#if expanded}
        <div class="brand-text">
          <strong>HyperBase</strong>
          <small>graph explorer</small>
        </div>
      {/if}
    </div>
    <button
      type="button"
      class="collapse-btn"
      on:click={toggleExpanded}
      title={expanded ? 'Collapse' : 'Expand'}
      aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
    >
      {#if expanded}
        <span class="chev">‹</span>
      {:else}
        <span class="chev">›</span>
      {/if}
    </button>
  </div>

  <div class="divider"></div>

  <!-- ===== Views ===== -->
  <section class="group">
    <header class="group-header">
      {#if expanded}
        <div class="group-title">
          <h3>Views</h3>
          <span class="count">3</span>
        </div>
        <div class="group-actions">
          <button type="button" class="icon-btn" title="Reset view" on:click={() => animateAndRun(() => loadOverviewGraph())}>+</button>
          <button type="button" class="icon-btn chev-btn" class:open={viewsOpen} on:click={() => (viewsOpen = !viewsOpen)} title="Toggle">⌄</button>
        </div>
      {:else}
        <span class="rail-label">VIEW</span>
      {/if}
    </header>

    {#if !expanded || viewsOpen}
      <div class="group-body">
        <button
          type="button"
          class="row mode-row"
          class:active={activeMode === 'folders'}
          on:click={() => animateAndRun(() => loadOverviewGraph())}
          title="Folders view"
        >
          <span class="row-icon folders-icon">▣</span>
          {#if expanded}
            <span class="row-main">
              <strong>Folders</strong>
              <small>Project overview</small>
            </span>
            <span class="row-meta">overview</span>
          {/if}
        </button>

        <button
          type="button"
          class="row mode-row"
          class:active={activeMode === 'files'}
          on:click={() => animateAndRun(() => loadGalaxyGraph())}
          title="Files view"
        >
          <span class="row-icon files-icon">☷</span>
          {#if expanded}
            <span class="row-main">
              <strong>Files</strong>
              <small>Galaxy of files</small>
            </span>
            <span class="row-meta">galaxy</span>
          {/if}
        </button>

        <button
          type="button"
          class="row mode-row"
          class:active={activeMode === 'functions'}
          on:click={() => animateAndRun(() => loadFullSymbolGraph())}
          title="Functions view"
        >
          <span class="row-icon functions-icon">◌</span>
          {#if expanded}
            <span class="row-main">
              <strong>Functions</strong>
              <small>Full symbol graph</small>
            </span>
            <span class="row-meta">symbols</span>
          {/if}
        </button>
      </div>
    {/if}
  </section>

  <div class="divider"></div>

  <!-- ===== Stats ===== -->
  <section class="group">
    <header class="group-header">
      {#if expanded}
        <div class="group-title">
          <h3>Stats</h3>
          <span class="count">{$graphStats.nodeCount + $graphStats.edgeCount}</span>
        </div>
        <div class="group-actions">
          <button type="button" class="icon-btn chev-btn" class:open={statsOpen} on:click={() => (statsOpen = !statsOpen)} title="Toggle">⌄</button>
        </div>
      {:else}
        <span class="rail-label">STAT</span>
      {/if}
    </header>

    {#if !expanded || statsOpen}
      <div class="group-body">
        {#if expanded}
          <div class="stat-card">
            <div class="stat-line">
              <span class="stat-num">{$graphStats.nodeCount}</span>
              <span class="stat-label">Nodes</span>
            </div>
            <div class="stat-line">
              <span class="stat-num">{$graphStats.edgeCount}</span>
              <span class="stat-label">Edges</span>
            </div>
          </div>
        {:else}
          <div class="rail-stats">
            <span>{$graphStats.nodeCount}</span>
            <small>n</small>
            <span>{$graphStats.edgeCount}</span>
            <small>e</small>
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <div class="divider"></div>

  <!-- ===== Codebase ===== -->
  <section class="group group-grow">
    <header class="group-header">
      {#if expanded}
        <div class="group-title">
          <h3>Codebase</h3>
          <span class="count">{$demoRepos.length}</span>
        </div>
        <div class="group-actions">
          <button type="button" class="icon-btn" title="Upload codebase.db" on:click={openUploadPicker}>+</button>
          <button type="button" class="icon-btn chev-btn" class:open={codebaseOpen} on:click={() => (codebaseOpen = !codebaseOpen)} title="Toggle">⌄</button>
        </div>
      {:else}
        <span class="rail-label">CODE</span>
      {/if}
    </header>

    {#if expanded && codebaseOpen}
      <div class="group-body">
        <div class="branch-row">
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
        </div>

        <button type="button" class="row upload-row" on:click={openUploadPicker}>
          <span class="row-icon upload-icon">⤴</span>
          <span class="row-main">
            <strong>Upload codebase.db</strong>
            <small>Replace current dataset</small>
          </span>
        </button>
        <input bind:this={uploadInput} class="hidden-input" type="file" accept=".db" on:change={(event) => void handleFilePick(event)} />

        {#if $demoRepos.length > 0}
          <div class="demo-list">
            {#each $demoRepos as demo}
              <button type="button" class="row demo-row" on:click={() => void chooseDemoRepo(demo.id)}>
                <span class="row-icon demo-icon">◆</span>
                <span class="row-main">
                  <strong>{demo.name}</strong>
                  <small>{demo.symbolCount} symbols</small>
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {:else if !expanded}
      <div class="group-body">
        <button type="button" class="row mode-row" on:click={openUploadPicker} title="Upload codebase.db">
          <span class="row-icon upload-icon">⤴</span>
        </button>
        <input bind:this={uploadInput} class="hidden-input" type="file" accept=".db" on:change={(event) => void handleFilePick(event)} />
      </div>
    {/if}
  </section>
</aside>

<style>
  /* ============================================================
     Premium dark sidebar — expandable / collapsible.
     Layout inspired by the slothChat reference, adapted to the
     existing dark theme tokens (var(--bg-*), var(--text-*),
     var(--border*), var(--text-accent)).
     ============================================================ */

  .sidebar {
    position: fixed;
    top: 14px;
    left: 14px;
    bottom: 14px;
    width: 76px;
    padding: 14px 10px;
    border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    border-radius: 26px;
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--bg-secondary) 96%, transparent) 0%,
        color-mix(in srgb, var(--bg-secondary) 88%, transparent) 100%
      );
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-backdrop-filter: blur(22px) saturate(140%);
    box-shadow:
      0 0px 0 0 color-mix(in srgb, white 6%, transparent) inset,
      0 30px 60px -20px rgba(0, 0, 0, 0.55),
      var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 12px;
    z-index: var(--z-controls);
    overflow: hidden;
    transition: width 320ms cubic-bezier(0.2, 0.8, 0.2, 1),
      padding 320ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .sidebar.expanded {
    width: 304px;
    padding: 16px 14px;
  }

  /* Soft accent glow */
  .sidebar::before {
    content: '';
    position: absolute;
    top: -40%;
    left: -40%;
    width: 180%;
    height: 60%;
    background: radial-gradient(
      ellipse at top left,
      color-mix(in srgb, var(--text-accent) 22%, transparent) 0%,
      transparent 60%
    );
    pointer-events: none;
    opacity: 0.55;
    filter: blur(8px);
  }
  .sidebar::after {
    content: '';
    position: absolute;
    top: 0;
    left: 14%;
    right: 14%;
    height: 1px;
    background: linear-gradient(90deg, transparent,
      color-mix(in srgb, white 35%, transparent), transparent);
    pointer-events: none;
  }

  /* ===== Header ===== */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 44px;
    position: relative;
  }
  .sidebar:not(.expanded) .header {
    flex-direction: column;
    gap: 12px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .logo {
    width: 40px;
    height: 40px;
    border-radius: 14px;
    display: grid;
    place-items: center;
    background: radial-gradient(
      circle at 30% 25%,
      color-mix(in srgb, white 45%, var(--text-accent)) 0%,
      var(--text-accent) 55%,
      color-mix(in srgb, var(--text-accent) 60%, black) 100%
    );
    color: var(--bg-primary);
    font-weight: 800;
    font-size: 17px;
    letter-spacing: -0.04em;
    box-shadow:
      0 0px 0 0 color-mix(in srgb, white 55%, transparent) inset,
      0 0px 0 0 color-mix(in srgb, black 25%, transparent) inset,
      0 6px 14px -4px color-mix(in srgb, var(--text-accent) 70%, transparent),
      0 0 0 0px color-mix(in srgb, var(--text-accent) 45%, transparent);
    flex-shrink: 0;
  }

  .brand-text {
    display: grid;
    gap: 1px;
    min-width: 0;
  }
  .brand-text strong {
    color: var(--text-primary);
    font-size: 15px;
    font-weight: 800;
    letter-spacing: -0.01em;
    line-height: 1.1;
  }
  .brand-text small {
    color: var(--text-secondary);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 700;
  }

  .collapse-btn {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    background: linear-gradient(180deg,
      color-mix(in srgb, var(--bg-tertiary) 100%, transparent),
      color-mix(in srgb, var(--bg-tertiary) 70%, transparent));
    color: var(--text-primary);
    cursor: pointer;
    display: grid;
    place-items: center;
    transition: transform 200ms ease, border-color 180ms ease, color 180ms ease,
      box-shadow 200ms ease;
    box-shadow: 0 0px 0 0 color-mix(in srgb, white 8%, transparent) inset,
      0 2px 6px rgba(0, 0, 0, 0.25);
    flex-shrink: 0;
  }
  .collapse-btn:hover {
    color: var(--text-accent);
    border-color: color-mix(in srgb, var(--border-accent) 70%, var(--border));
    box-shadow: 0 0px 0 0 color-mix(in srgb, white 10%, transparent) inset,
      0 8px 20px -8px color-mix(in srgb, var(--text-accent) 50%, transparent);
  }
  .chev {
    font-size: 18px;
    line-height: 1;
    font-weight: 700;
    transform: translateY(-1px);
  }

  /* ===== Divider ===== */
  .divider {
    height: 1px;
    background: linear-gradient(90deg, transparent,
      color-mix(in srgb, var(--border) 100%, transparent), transparent);
    margin: 2px 0;
  }

  /* ===== Group ===== */
  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .group-grow { flex: 1 1 auto; min-height: 0; }

  .group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 28px;
  }

  .group-title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .group-title h3 {
    margin: 0;
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 800;
    letter-spacing: -0.01em;
  }
  .count {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 999px;
    color: var(--text-accent);
    background: color-mix(in srgb, var(--text-accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--text-accent) 30%, transparent);
    font-variant-numeric: tabular-nums;
  }

  .group-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .icon-btn {
    width: 26px;
    height: 26px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    display: grid;
    place-items: center;
    font-size: 14px;
    line-height: 1;
    transition: color 160ms ease, background 160ms ease, border-color 160ms ease,
      transform 200ms ease;
  }
  .icon-btn:hover {
    color: var(--text-primary);
    background: color-mix(in srgb, var(--bg-tertiary) 70%, transparent);
    border-color: color-mix(in srgb, var(--border) 80%, transparent);
  }
  .chev-btn {
    transform: rotate(0deg);
    font-weight: 700;
  }
  .chev-btn.open { transform: rotate(180deg); }

  .rail-label {
    width: 100%;
    text-align: center;
    font-size: 9px;
    letter-spacing: 0.18em;
    color: var(--text-secondary);
    font-weight: 800;
    padding: 2px 0;
  }

  .group-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .group-grow .group-body {
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 2px;
    scrollbar-width: thin;
  }

  /* ===== Row (shared) ===== */
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    border-radius: 14px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-primary);
    padding: 8px 10px;
    cursor: pointer;
    text-align: left;
    transition: background 180ms ease, border-color 180ms ease,
      transform 180ms ease, box-shadow 220ms ease, color 180ms ease;
  }
  .sidebar:not(.expanded) .row {
    justify-content: center;
    padding: 10px 0;
  }
  .row:hover {
    background: color-mix(in srgb, var(--bg-tertiary) 60%, transparent);
    border-color: color-mix(in srgb, var(--border) 70%, transparent);
  }

  .row-icon {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    font-size: 16px;
    color: var(--text-primary);
    background: linear-gradient(180deg,
      color-mix(in srgb, var(--bg-tertiary) 100%, transparent),
      color-mix(in srgb, var(--bg-tertiary) 75%, transparent));
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    box-shadow: 0 0px 0 0 color-mix(in srgb, white 6%, transparent) inset;
  }

  .folders-icon { color: color-mix(in srgb, #4ade80 80%, var(--text-primary)); }
  .files-icon   { color: color-mix(in srgb, #60a5fa 80%, var(--text-primary)); }
  .functions-icon { color: color-mix(in srgb, #f472b6 80%, var(--text-primary)); }
  .upload-icon  { color: var(--text-accent); }
  .demo-icon    { color: color-mix(in srgb, var(--text-accent) 80%, var(--text-primary)); }

  .row-main {
    display: grid;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .row-main strong {
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: -0.005em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-main small {
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    margin-left: auto;
    color: var(--text-secondary);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  /* Active mode row — accent fill + left rail */
  .mode-row.active {
    background: linear-gradient(180deg,
      color-mix(in srgb, var(--text-accent) 18%, transparent),
      color-mix(in srgb, var(--text-accent) 8%, transparent));
    border-color: color-mix(in srgb, var(--border-accent) 80%, transparent);
    box-shadow:
      0 0px 0 0 color-mix(in srgb, white 10%, transparent) inset,
      0 0 0 1px color-mix(in srgb, var(--text-accent) 25%, transparent) inset,
      0 10px 24px -12px color-mix(in srgb, var(--text-accent) 60%, transparent);
  }
  .mode-row.active .row-main strong { color: var(--text-accent); }
  .mode-row.active::before {
    content: '';
    position: absolute;
    left: -10px;
    top: 22%;
    bottom: 22%;
    width: 3px;
    border-radius: 3px;
    background: linear-gradient(180deg, transparent, var(--text-accent), transparent);
    box-shadow: 0 0 12px color-mix(in srgb, var(--text-accent) 70%, transparent);
  }
  .mode-row.active .row-icon {
    border-color: color-mix(in srgb, var(--text-accent) 50%, transparent);
    background: linear-gradient(180deg,
      color-mix(in srgb, var(--text-accent) 22%, var(--bg-tertiary)),
      color-mix(in srgb, var(--text-accent) 10%, var(--bg-tertiary)));
    color: var(--text-accent);
  }

  /* ===== Stats ===== */
  .stat-card {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    padding: 12px;
    border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    background: linear-gradient(180deg,
      color-mix(in srgb, var(--bg-tertiary) 60%, transparent),
      color-mix(in srgb, var(--bg-tertiary) 30%, transparent));
    box-shadow: 0 0px 0 0 color-mix(in srgb, white 5%, transparent) inset;
  }
  .stat-line { display: grid; gap: 2px; }
  .stat-num {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    background: linear-gradient(180deg, var(--text-primary),
      color-mix(in srgb, var(--text-primary) 60%, var(--text-accent)));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .stat-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-secondary);
    font-weight: 700;
  }

  .rail-stats {
    display: grid;
    justify-items: center;
    gap: 1px;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
  .rail-stats small {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-secondary);
  }

  /* ===== Codebase ===== */
  .branch-row { display: grid; gap: 4px; }
  .branch-row label {
    color: var(--text-secondary);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-weight: 700;
  }
  .branch-row select {
    width: 100%;
    background: linear-gradient(180deg,
      color-mix(in srgb, var(--bg-tertiary) 100%, transparent),
      color-mix(in srgb, var(--bg-tertiary) 75%, transparent));
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    color: var(--text-primary);
    border-radius: 12px;
    padding: 9px 12px;
    font-weight: 600;
    font-size: 12px;
    transition: border-color 180ms ease, box-shadow 180ms ease;
    box-shadow: 0 0px 0 0 color-mix(in srgb, white 5%, transparent) inset;
  }
  .branch-row select:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--border-accent) 80%, transparent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--text-accent) 18%, transparent);
  }

  .upload-row {
    border: 1px dashed color-mix(in srgb, var(--border-accent) 60%, var(--border));
    background: color-mix(in srgb, var(--text-accent) 6%, transparent);
  }
  .upload-row:hover {
    background: color-mix(in srgb, var(--text-accent) 12%, transparent);
    border-style: solid;
  }

  .demo-list { display: grid; gap: 6px; }

  .hidden-input { display: none; }

  /* Scrollbar polish */
  .group-body::-webkit-scrollbar { width: 6px; }
  .group-body::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--border) 100%, transparent);
    border-radius: 3px;
  }
</style>
