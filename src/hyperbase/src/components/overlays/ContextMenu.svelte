<script lang="ts">
  export let open = false;
  export let x = 0;
  export let y = 0;
  export let noteExists = false;
  export let onAddNote: () => void;
  export let onClose: () => void;

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  function handleBackdropKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClose();
    }
  }
</script>

{#if open}
  <div
    class="backdrop"
    role="button"
    tabindex="0"
    on:click={handleBackdropClick}
    on:keydown={handleBackdropKeydown}
    on:contextmenu|preventDefault={handleBackdropClick}
  >
    <div class="menu" style={`left:${x}px; top:${y}px;`}>
      <button type="button" class="item" on:click={onAddNote}>{noteExists ? 'Edit note' : 'Add note'}</button>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: calc(var(--z-modal) + 5);
  }

  .menu {
    position: fixed;
    min-width: 180px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    padding: var(--space-xs);
    transform: translate(0, 0);
  }

  .item {
    width: 100%;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-primary);
    padding: 10px 12px;
    text-align: left;
  }

  .item:hover {
    background: var(--bg-hover);
  }
</style>
