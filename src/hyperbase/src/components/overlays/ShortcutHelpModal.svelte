<script lang="ts">
  export let open = false;
  export let onClose: () => void = () => {};

  const shortcuts = [
    { key: '/', description: 'Focus search' },
    { key: 'Esc', description: 'Clear selection and close transient UI' },
    { key: 'Space', description: 'Reset camera' },
    { key: 'G', description: 'Load galaxy view' },
    { key: 'R', description: 'Blast radius from selection' },
    { key: 'P', description: 'Enter path-finding mode' },
    { key: 'F', description: 'Toggle focus mode' },
    { key: 'D', description: 'Cycle overlays' },
    { key: '?', description: 'Show this shortcut reference' },
  ];
</script>

{#if open}
  <button class="backdrop" type="button" aria-label="Close shortcut help" on:click={onClose}>
    <div
      class="card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcut-help-title"
      tabindex="-1"
      on:mousedown|stopPropagation
    >
      <h2 id="shortcut-help-title">Keyboard shortcuts</h2>
      <div class="shortcut-list">
        {#each shortcuts as shortcut}
          <div class="shortcut-row">
            <kbd>{shortcut.key}</kbd>
            <span>{shortcut.description}</span>
          </div>
        {/each}
      </div>
    </div>
  </button>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    border: 0;
    background: var(--bg-overlay);
    backdrop-filter: blur(6px);
    z-index: var(--z-modal);
  }

  .card {
    width: min(520px, calc(100vw - 32px));
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: var(--space-xl);
    text-align: left;
  }

  h2 {
    margin: 0 0 var(--space-lg);
    font-size: 24px;
  }

  .shortcut-list {
    display: grid;
    gap: var(--space-sm);
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-lg);
    color: var(--text-primary);
  }

  kbd {
    min-width: 48px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-accent);
    font-family: 'SFMono-Regular', ui-monospace, monospace;
    font-size: 12px;
    font-weight: 700;
    padding: 6px 8px;
  }

  span {
    color: var(--text-secondary);
    text-align: right;
  }
</style>
