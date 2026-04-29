import type { UrlState } from '../types';

export function readUrlState(): UrlState {
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const depth = params.get('depth');

  return {
    branch: params.get('branch') ?? undefined,
    symbolId: params.get('symbol') ?? undefined,
    depth: depth ? Number.parseInt(depth, 10) : undefined,
    view: params.get('view') ?? undefined,
  };
}

export function writeUrlState(state: UrlState): void {
  const params = new URLSearchParams();

  if (state.branch) params.set('branch', state.branch);
  if (state.symbolId) params.set('symbol', state.symbolId);
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
