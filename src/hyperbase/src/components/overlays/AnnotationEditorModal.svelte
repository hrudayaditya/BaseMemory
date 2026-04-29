<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { annotationEditor, closeAnnotationEditor, saveAnnotation } from '../../lib/annotations';
  import { selectedNodeData, selectedSymbolDetail } from '../../stores/selection';

  let editor = get(annotationEditor);
  let draft = '';

  const unsubscribe = annotationEditor.subscribe((value) => {
    editor = value;
    draft = value?.note ?? '';
  });

  onDestroy(() => unsubscribe());

  function close() {
    closeAnnotationEditor();
  }

  function save() {
    if (!editor) {
      return;
    }
    saveAnnotation(editor.nodeId, draft);
    close();
  }

  function titleFor(nodeId: string): string {
    if ($selectedSymbolDetail?.id === nodeId) {
      return $selectedSymbolDetail.name;
    }
    const label = $selectedNodeData && typeof $selectedNodeData === 'object' ? Reflect.get($selectedNodeData, 'label') : null;
    return typeof label === 'string' ? label : nodeId;
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      close();
    }
  }

  function handleBackdropKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      close();
    }
  }
</script>

{#if editor}
  <div class="backdrop" role="button" tabindex="0" on:click={handleBackdropClick} on:keydown={handleBackdropKeydown}>
    <div class="modal">
      <div class="header">
        <div>
          <p class="eyebrow">Annotation</p>
          <h2>{titleFor(editor.nodeId)}</h2>
        </div>
        <button type="button" class="close-button" on:click={close}>×</button>
      </div>

      <label class="field">
        <span>Note</span>
        <textarea bind:value={draft} rows={8} placeholder="Capture what matters about this node."></textarea>
      </label>

      <div class="actions">
        <button type="button" class="secondary" on:click={close}>Cancel</button>
        <button type="button" class="primary" on:click={save}>Save note</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: calc(var(--z-modal) + 10);
    background: var(--bg-overlay);
    display: grid;
    place-items: center;
    padding: var(--space-lg);
  }

  .modal {
    width: min(560px, 100%);
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
    align-items: flex-start;
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
    font-size: 24px;
    line-height: 1.2;
    color: var(--text-primary);
  }

  .close-button {
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    font-size: 28px;
    line-height: 1;
  }

  .field {
    display: grid;
    gap: var(--space-sm);
    color: var(--text-secondary);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  textarea {
    width: 100%;
    resize: vertical;
    min-height: 180px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    padding: 12px 14px;
    font: inherit;
    text-transform: none;
    letter-spacing: normal;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
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
