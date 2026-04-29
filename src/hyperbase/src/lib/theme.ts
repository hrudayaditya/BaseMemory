export interface HyperbaseTheme {
  background: {
    primary: string;
    secondary: string;
    tertiary: string;
    hover: string;
    overlay: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
    accent: string;
  };
  node: {
    function: string;
    method: string;
    struct: string;
    class: string;
    constant: string;
    module: string;
    interface: string;
    type: string;
    default: string;
    highlight: string;
    dimmed: string;
  };
  edge: {
    file: string;
    default: string;
    resolved: string;
    unresolved: string;
    highlighted: string;
    path: string;
  };
  language: {
    typescript: string;
    javascript: string;
    rust: string;
    python: string;
    go: string;
    default: string;
  };
  analytics: {
    degreeLow: string;
    degreeHigh: string;
    couplingSame: string;
    couplingCross: string;
    couplingHot: string;
    hotspot: string;
    blastDepth1: string;
    blastDepth2: string;
    blastDepth3: string;
    blastDepthBeyond: string;
  };
  border: {
    base: string;
    accent: string;
  };
  minimap: {
    background: string;
    edge: string;
    viewportFill: string;
    viewportStroke: string;
  };
}

const FALLBACK_THEME: HyperbaseTheme = {
  background: {
    primary: '#0d1117',
    secondary: '#161b22',
    tertiary: '#21262d',
    hover: '#30363d',
    overlay: 'rgba(13, 17, 23, 0.55)',
  },
  text: {
    primary: '#e6edf3',
    secondary: '#8b949e',
    muted: '#484f58',
    accent: '#4f9cf9',
  },
  node: {
    function: '#4f9cf9',
    method: '#7dd3fc',
    struct: '#f97316',
    class: '#fb923c',
    constant: '#fbbf24',
    module: '#6b7280',
    interface: '#a78bfa',
    type: '#c4b5fd',
    default: '#94a3b8',
    highlight: '#ffffff',
    dimmed: 'rgba(148, 163, 184, 0.15)',
  },
  edge: {
    file: 'rgba(255, 255, 255, 0.08)',
    default: 'rgba(255, 255, 255, 0.12)',
    resolved: 'rgba(255, 255, 255, 0.15)',
    unresolved: 'rgba(255, 255, 255, 0.04)',
    highlighted: 'rgba(79, 156, 249, 0.8)',
    path: 'rgba(251, 191, 36, 0.9)',
  },
  language: {
    typescript: '#4f9cf9',
    javascript: '#fbbf24',
    rust: '#f97316',
    python: '#34d399',
    go: '#7dd3fc',
    default: '#94a3b8',
  },
  analytics: {
    degreeLow: '#5aa8ff',
    degreeHigh: '#ff7a1a',
    couplingSame: 'rgba(255, 255, 255, 0.08)',
    couplingCross: 'rgba(79, 156, 249, 0.82)',
    couplingHot: 'rgba(251, 191, 36, 0.92)',
    hotspot: '#ffffff',
    blastDepth1: '#ef4444',
    blastDepth2: '#f97316',
    blastDepth3: '#fbbf24',
    blastDepthBeyond: 'rgba(251, 191, 36, 0.48)',
  },
  border: {
    base: 'rgba(255, 255, 255, 0.08)',
    accent: 'rgba(79, 156, 249, 0.4)',
  },
  minimap: {
    background: '#161b22',
    edge: 'rgba(255, 255, 255, 0.08)',
    viewportFill: 'rgba(79, 156, 249, 0.12)',
    viewportStroke: 'rgba(79, 156, 249, 0.8)',
  },
};

let cachedTheme: HyperbaseTheme | null = null;

function readToken(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}

export function initializeTheme(root: HTMLElement = document.documentElement): HyperbaseTheme {
  const styles = getComputedStyle(root);
  cachedTheme = {
    background: {
      primary: readToken(styles, '--bg-primary', FALLBACK_THEME.background.primary),
      secondary: readToken(styles, '--bg-secondary', FALLBACK_THEME.background.secondary),
      tertiary: readToken(styles, '--bg-tertiary', FALLBACK_THEME.background.tertiary),
      hover: readToken(styles, '--bg-hover', FALLBACK_THEME.background.hover),
      overlay: readToken(styles, '--bg-overlay', FALLBACK_THEME.background.overlay),
    },
    text: {
      primary: readToken(styles, '--text-primary', FALLBACK_THEME.text.primary),
      secondary: readToken(styles, '--text-secondary', FALLBACK_THEME.text.secondary),
      muted: readToken(styles, '--text-muted', FALLBACK_THEME.text.muted),
      accent: readToken(styles, '--text-accent', FALLBACK_THEME.text.accent),
    },
    node: {
      function: readToken(styles, '--node-function', FALLBACK_THEME.node.function),
      method: readToken(styles, '--node-method', FALLBACK_THEME.node.method),
      struct: readToken(styles, '--node-struct', FALLBACK_THEME.node.struct),
      class: readToken(styles, '--node-class', FALLBACK_THEME.node.class),
      constant: readToken(styles, '--node-constant', FALLBACK_THEME.node.constant),
      module: readToken(styles, '--node-module', FALLBACK_THEME.node.module),
      interface: readToken(styles, '--node-interface', FALLBACK_THEME.node.interface),
      type: readToken(styles, '--node-type', FALLBACK_THEME.node.type),
      default: readToken(styles, '--node-default', FALLBACK_THEME.node.default),
      highlight: readToken(styles, '--node-highlight', FALLBACK_THEME.node.highlight),
      dimmed: readToken(styles, '--node-dimmed', FALLBACK_THEME.node.dimmed),
    },
    edge: {
      file: readToken(styles, '--edge-file', FALLBACK_THEME.edge.file),
      default: readToken(styles, '--edge-default', FALLBACK_THEME.edge.default),
      resolved: readToken(styles, '--edge-resolved', FALLBACK_THEME.edge.resolved),
      unresolved: readToken(styles, '--edge-unresolved', FALLBACK_THEME.edge.unresolved),
      highlighted: readToken(styles, '--edge-highlighted', FALLBACK_THEME.edge.highlighted),
      path: readToken(styles, '--edge-path', FALLBACK_THEME.edge.path),
    },
    language: {
      typescript: readToken(styles, '--language-typescript', FALLBACK_THEME.language.typescript),
      javascript: readToken(styles, '--language-javascript', FALLBACK_THEME.language.javascript),
      rust: readToken(styles, '--language-rust', FALLBACK_THEME.language.rust),
      python: readToken(styles, '--language-python', FALLBACK_THEME.language.python),
      go: readToken(styles, '--language-go', FALLBACK_THEME.language.go),
      default: readToken(styles, '--language-default', FALLBACK_THEME.language.default),
    },
    analytics: {
      degreeLow: readToken(styles, '--analytics-degree-low', FALLBACK_THEME.analytics.degreeLow),
      degreeHigh: readToken(styles, '--analytics-degree-high', FALLBACK_THEME.analytics.degreeHigh),
      couplingSame: readToken(styles, '--analytics-coupling-same', FALLBACK_THEME.analytics.couplingSame),
      couplingCross: readToken(styles, '--analytics-coupling-cross', FALLBACK_THEME.analytics.couplingCross),
      couplingHot: readToken(styles, '--analytics-coupling-hot', FALLBACK_THEME.analytics.couplingHot),
      hotspot: readToken(styles, '--analytics-hotspot', FALLBACK_THEME.analytics.hotspot),
      blastDepth1: readToken(styles, '--analytics-blast-depth-1', FALLBACK_THEME.analytics.blastDepth1),
      blastDepth2: readToken(styles, '--analytics-blast-depth-2', FALLBACK_THEME.analytics.blastDepth2),
      blastDepth3: readToken(styles, '--analytics-blast-depth-3', FALLBACK_THEME.analytics.blastDepth3),
      blastDepthBeyond: readToken(styles, '--analytics-blast-depth-beyond', FALLBACK_THEME.analytics.blastDepthBeyond),
    },
    border: {
      base: readToken(styles, '--border', FALLBACK_THEME.border.base),
      accent: readToken(styles, '--border-accent', FALLBACK_THEME.border.accent),
    },
    minimap: {
      background: readToken(styles, '--minimap-background', FALLBACK_THEME.minimap.background),
      edge: readToken(styles, '--minimap-edge', FALLBACK_THEME.minimap.edge),
      viewportFill: readToken(styles, '--minimap-viewport-fill', FALLBACK_THEME.minimap.viewportFill),
      viewportStroke: readToken(styles, '--minimap-viewport-stroke', FALLBACK_THEME.minimap.viewportStroke),
    },
  };

  return cachedTheme;
}

export function getTheme(): HyperbaseTheme {
  if (cachedTheme) {
    return cachedTheme;
  }

  if (typeof document !== 'undefined') {
    return initializeTheme(document.documentElement);
  }

  return FALLBACK_THEME;
}

export function communityColorFor(key: string): string {
  const theme = getTheme();
  const palette = [
    theme.node.function,
    theme.node.method,
    theme.node.struct,
    theme.node.class,
    theme.node.constant,
    theme.node.interface,
    theme.node.type,
    theme.text.accent,
  ];

  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }

  return palette[hash % palette.length] ?? theme.node.default;
}
