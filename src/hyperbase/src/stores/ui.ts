import { writable } from 'svelte/store';
import type { SearchResult, Overlay } from '../types';

export const sidebarOpen = writable<boolean>(false);
export const activeOverlay = writable<Overlay>('none');
export const graphDepth = writable<number>(1);
export const searchQuery = writable<string>('');
export const searchResults = writable<SearchResult[]>([]);
export const searchOpen = writable<boolean>(false);
export const searchFocusNonce = writable<number>(0);
export const shortcutHelpOpen = writable<boolean>(false);
export const pathFindingMode = writable<boolean>(false);
export const pathFindingSource = writable<string | null>(null);
export const pathFindingHint = writable<string | null>(null);
export const focusMode = writable<boolean>(false);
export const focusedNodeIds = writable<Set<string>>(new Set());
export const handoffModal = writable<{ title: string; markdown: string } | null>(null);

export function requestSearchFocus(): void {
  searchFocusNonce.update((value) => value + 1);
}

export function closeSearchDropdown(): void {
  searchOpen.set(false);
}

export function startPathFinding(sourceNodeId: string | null): void {
  pathFindingMode.set(true);
  pathFindingSource.set(sourceNodeId);
}

export function cancelPathFinding(): void {
  pathFindingMode.set(false);
  pathFindingSource.set(null);
  pathFindingHint.set(null);
}

export function setFocusMode(active: boolean, nodeIds: Iterable<string> = []): void {
  focusMode.set(active);
  focusedNodeIds.set(active ? new Set(nodeIds) : new Set());
}

export function openHandoffModal(title: string, markdown: string): void {
  handoffModal.set({ title, markdown });
}

export function closeHandoffModal(): void {
  handoffModal.set(null);
}
