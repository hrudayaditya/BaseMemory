import type { UrlState } from '../types';

export function readUrlState(): UrlState {
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const depth = params.get('depth');
  const focused = params.get('focused');

  return {
    branch: params.get('branch') ?? undefined,
    symbolId: params.get('symbol') ?? undefined,
    filePath: params.get('file') ?? undefined,
    fromId: params.get('from') ?? undefined,
    toId: params.get('to') ?? undefined,
    directoryPath: params.get('directory') ?? undefined,
    focus: params.get('focus') === '1',
    focusedIds: focused ? focused.split(',').map((value) => value.trim()).filter(Boolean) : undefined,
    depth: depth ? Number.parseInt(depth, 10) : undefined,
    view: params.get('view') ?? undefined,
  };
}

export function writeUrlState(state: UrlState): void {
  const params = new URLSearchParams();

  if (state.branch) params.set('branch', state.branch);
  if (state.symbolId) params.set('symbol', state.symbolId);
  if (state.filePath) params.set('file', state.filePath);
  if (state.fromId) params.set('from', state.fromId);
  if (state.toId) params.set('to', state.toId);
  if (state.directoryPath) params.set('directory', state.directoryPath);
  if (state.focus) params.set('focus', '1');
  if (state.focusedIds && state.focusedIds.length > 0) {
    params.set('focused', state.focusedIds.join(','));
  }
  if (typeof state.depth === 'number' && Number.isFinite(state.depth)) {
    params.set('depth', String(state.depth));
  }
  if (state.view) params.set('view', state.view);

  const nextHash = params.toString();
  const target = nextHash.length > 0 ? `#${nextHash}` : '#';
  if (window.location.hash !== target) {
    history.replaceState(null, '', target);
  }
}
