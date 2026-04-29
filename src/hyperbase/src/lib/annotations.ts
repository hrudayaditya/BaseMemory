import { derived, get, writable } from 'svelte/store';
import { selectedNodeId } from '../stores/selection';

export interface AnnotationEntry {
  note: string;
  updatedAt: string;
}

interface AnnotationEditorState {
  nodeId: string;
  note: string;
}

const STORAGE_KEY = 'hyperbase:annotations:v1';

const annotationsState = writable<Record<string, AnnotationEntry>>({});
const editorState = writable<AnnotationEditorState | null>(null);

let loaded = false;

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function persist(next: Record<string, AnnotationEntry>): void {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function ensureLoaded(): void {
  if (loaded || !canUseStorage()) {
    loaded = true;
    return;
  }

  loaded = true;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, AnnotationEntry>;
    if (parsed && typeof parsed === 'object') {
      annotationsState.set(parsed);
    }
  } catch {
    annotationsState.set({});
  }
}

export const annotations = {
  subscribe(run: (value: Record<string, AnnotationEntry>) => void) {
    ensureLoaded();
    return annotationsState.subscribe(run);
  },
};

export const annotationEditor = {
  subscribe(run: (value: AnnotationEditorState | null) => void) {
    return editorState.subscribe(run);
  },
};

export const selectedAnnotation = derived([selectedNodeId, annotations], ([$selectedNodeId, $annotations]) => {
  if (!$selectedNodeId) {
    return null;
  }
  return $annotations[$selectedNodeId] ?? null;
});

export function getAnnotation(nodeId: string | null): AnnotationEntry | null {
  ensureLoaded();
  if (!nodeId) {
    return null;
  }
  return get(annotationsState)[nodeId] ?? null;
}

export function hasAnnotation(nodeId: string | null): boolean {
  return Boolean(getAnnotation(nodeId));
}

export function saveAnnotation(nodeId: string, note: string): void {
  ensureLoaded();
  const trimmed = note.trim();
  annotationsState.update((current) => {
    const next = { ...current };
    if (!trimmed) {
      delete next[nodeId];
    } else {
      next[nodeId] = {
        note: trimmed,
        updatedAt: new Date().toISOString(),
      };
    }
    persist(next);
    return next;
  });
}

export function removeAnnotation(nodeId: string): void {
  saveAnnotation(nodeId, '');
}

export function openAnnotationEditor(nodeId: string, seedNote?: string | null): void {
  ensureLoaded();
  editorState.set({
    nodeId,
    note: seedNote ?? getAnnotation(nodeId)?.note ?? '',
  });
}

export function closeAnnotationEditor(): void {
  editorState.set(null);
}
