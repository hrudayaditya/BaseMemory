export const NODE_COLORS: Record<string, string> = {
  function: 'var(--node-function)',
  method: 'var(--node-method)',
  struct: 'var(--node-struct)',
  class: 'var(--node-class)',
  constant: 'var(--node-constant)',
  module: 'var(--node-module)',
  interface: 'var(--node-interface)',
  type: 'var(--node-type)',
};

export const NODE_COLOR_DEFAULT = 'var(--node-default)';

export const MIN_NODE_SIZE = 3;
export const MAX_NODE_SIZE = 18;
export const TRUNCATION_WARNING_THRESHOLD = 250;
export const SEARCH_DEBOUNCE_MS = 200;
export const LAYOUT_ITERATIONS = 500;
export const LAYOUT_WORKER_BATCH = 50;
export const ZOOM_GALAXY_THRESHOLD = 0.3;
export const ZOOM_ATOM_THRESHOLD = 1.5;

export const LANGUAGE_COLORS: Record<string, string> = {
  typescript: '#4f9cf9',
  javascript: '#fbbf24',
  rust: '#f97316',
  python: '#34d399',
  go: '#7dd3fc',
};
