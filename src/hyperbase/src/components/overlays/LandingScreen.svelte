<script lang="ts">
  import { demoRepos, selectDemoGraph, uploadDatabaseGraph } from '../../stores/graph';

  let dragActive = false;
  let uploadError: string | null = null;
  let fileInput: HTMLInputElement;

  async function handleFiles(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) {
      return;
    }
    if (!file.name.endsWith('.db')) {
      uploadError = "This file doesn't look like a HyperBase index. Make sure to select a `.opencode/index/codebase.db` file.";
      return;
    }
    uploadError = null;
    await uploadDatabaseGraph(file);
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragActive = false;
    await handleFiles(event.dataTransfer?.files ?? null);
  }
</script>

<section class="landing-shell">
  <div class="landing-card">
    <p class="eyebrow">HyperBase</p>
    <h1>Understand any codebase, visually</h1>
    <p class="subtitle">Drop your `codebase.db` file and HyperBase will open the graph immediately.</p>

    <div
      role="group"
      class:drag-active={dragActive}
      class="drop-zone"
      on:dragenter|preventDefault={() => (dragActive = true)}
      on:dragover|preventDefault={() => (dragActive = true)}
      on:dragleave|preventDefault={() => (dragActive = false)}
      on:drop={handleDrop}
    >
      <p>Drop your `codebase.db` file here</p>
      <button type="button" class="primary" on:click={() => fileInput?.click()}>Choose file</button>
      <input bind:this={fileInput} type="file" accept=".db" hidden on:change={(event) => void handleFiles((event.currentTarget as HTMLInputElement).files)} />
    </div>

    {#if uploadError}
      <div class="error-copy">{uploadError}</div>
    {/if}

    <div class="demo-block">
      <div class="demo-header">
        <h2>Try a demo</h2>
        <p>Load a pre-indexed repo and explore immediately.</p>
      </div>

      <div class="demo-grid">
        {#each $demoRepos as demo}
          <button type="button" class="demo-card" on:click={() => void selectDemoGraph(demo.id)}>
            <div class="demo-topline">
              <span class="repo-dot"></span>
              <span class="language">{demo.language}</span>
            </div>
            <strong>{demo.name}</strong>
            <p>{demo.description}</p>
            <div class="stats">
              <span>{demo.fileCount} files</span>
              <span>{demo.symbolCount} symbols</span>
            </div>
          </button>
        {/each}
      </div>
    </div>
  </div>
</section>

<style>
  .landing-shell {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--space-xl);
    background:
      radial-gradient(circle at top left, color-mix(in srgb, var(--text-accent) 15%, transparent), transparent 42%),
      radial-gradient(circle at bottom right, color-mix(in srgb, var(--node-constant) 18%, transparent), transparent 36%),
      var(--bg-primary);
  }

  .landing-card {
    width: min(920px, 100%);
    padding: 40px;
    border-radius: 28px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg-secondary) 92%, transparent);
    box-shadow: var(--shadow-lg);
    display: grid;
    gap: 24px;
  }

  .eyebrow {
    margin: 0;
    color: var(--text-accent);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12px;
    font-weight: 700;
  }

  h1 {
    margin: 0;
    font-size: clamp(40px, 5vw, 62px);
    line-height: 1;
  }

  .subtitle {
    margin: 0;
    color: var(--text-secondary);
    font-size: 18px;
    max-width: 640px;
  }

  .drop-zone {
    border: 1px dashed color-mix(in srgb, var(--text-accent) 36%, transparent);
    background: color-mix(in srgb, var(--bg-tertiary) 85%, transparent);
    border-radius: 24px;
    padding: 40px 28px;
    display: grid;
    gap: 18px;
    justify-items: center;
    text-align: center;
    transition: transform var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
  }

  .drop-zone.drag-active {
    transform: translateY(-2px);
    border-color: var(--text-accent);
    background: color-mix(in srgb, var(--text-accent) 8%, var(--bg-tertiary));
  }

  .drop-zone p {
    margin: 0;
    font-size: 20px;
  }

  .primary {
    border: 0;
    border-radius: var(--radius-lg);
    background: var(--text-accent);
    color: var(--bg-primary);
    padding: 12px 18px;
    font-weight: 700;
  }

  .error-copy {
    border-radius: var(--radius-md);
    padding: 12px 14px;
    background: color-mix(in srgb, var(--node-constant) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--node-constant) 28%, transparent);
    color: var(--text-primary);
  }

  .demo-block {
    display: grid;
    gap: 16px;
  }

  .demo-header h2,
  .demo-header p {
    margin: 0;
  }

  .demo-header p {
    margin-top: 6px;
    color: var(--text-secondary);
  }

  .demo-grid {
    display: grid;
    gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .demo-card {
    text-align: left;
    border-radius: 22px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    padding: 18px;
    display: grid;
    gap: 10px;
    transition: transform var(--transition-fast), border-color var(--transition-fast);
  }

  .demo-card:hover {
    transform: translateY(-2px);
    border-color: var(--border-accent);
  }

  .demo-card p,
  .demo-card strong {
    margin: 0;
  }

  .demo-card p {
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .demo-topline {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .repo-dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--text-accent);
  }

  .language {
    color: var(--text-muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .stats {
    display: flex;
    gap: 14px;
    color: var(--text-primary);
    font-size: 13px;
  }
</style>
