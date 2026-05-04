<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { closeHandoffModal, handoffModal } from '../../stores/ui';
  import { downloadTextFile } from '../../lib/export';

  let modal = get(handoffModal);
  const unsubscribe = handoffModal.subscribe((value) => {
    modal = value;
  });

  onDestroy(() => unsubscribe());

  async function copy() {
    if (!modal) {
      return;
    }
    await navigator.clipboard.writeText(modal.markdown);
  }

  function download() {
    if (!modal) {
      return;
    }
    const safeName = modal.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    downloadTextFile(modal.markdown, `${safeName || 'handoff'}.md`, 'text/markdown;charset=utf-8');
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      closeHandoffModal();
    }
  }

  function handleBackdropKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      closeHandoffModal();
    }
  }
</script>

{#if modal}
  <div class="backdrop" role="button" tabindex="0" on:click={handleBackdropClick} on:keydown={handleBackdropKeydown}>
    <div class="modal">
      <div class="header">
        <div>
          <p class="eyebrow">Handoff Report</p>
          <h2>{modal.title}</h2>
        </div>
        <button type="button" class="close-button" on:click={closeHandoffModal}>×</button>
      </div>

      <pre class="markdown">{modal.markdown}</pre>

      <div class="actions">
        <button type="button" class="secondary" on:click={closeHandoffModal}>Close</button>
        <button type="button" class="secondary" on:click={copy}>Copy to clipboard</button>
        <button type="button" class="primary" on:click={download}>Download .md</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: calc(var(--z-modal) + 20);
    background: var(--bg-overlay);
    display: grid;
    place-items: center;
    padding: var(--space-lg);
  }

  .modal {
    width: min(860px, 100%);
    max-height: 80vh;
    overflow: auto;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: var(--space-lg);
    display: grid;
    gap: var(--space-md);
  }

  .header {
    display: flex;
    justify-content: space-between;
    gap: var(--space-md);
  }

  .eyebrow {
    margin: 0 0 6px;
    color: var(--text-secondary);
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    color: var(--text-primary);
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

  .markdown {
    margin: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-family: 'SFMono-Regular', ui-monospace, monospace;
    font-size: 12px;
    line-height: 1.55;
    padding: var(--space-md);
    white-space: pre-wrap;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .secondary,
  .primary {
    border-radius: var(--radius-md);
    padding: 10px 14px;
  }

  .secondary {
    border: 1px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .primary {
    border: 0;
    background: var(--text-accent);
    color: var(--bg-primary);
  }
</style>
