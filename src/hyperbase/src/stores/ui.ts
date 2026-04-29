import { writable } from 'svelte/store';
import type { SearchResult, Overlay } from '../types';

export const sidebarOpen = writable<boolean>(false);
export const activeOverlay = writable<Overlay>('none');
export const graphDepth = writable<number>(1);
export const searchQuery = writable<string>('');
export const searchResults = writable<SearchResult[]>([]);
export const searchOpen = writable<boolean>(false);
