import type { Settings } from 'sigma/settings';

export function buildSigmaSettings(): Partial<Settings> {
  return {
    renderEdgeLabels: false,
    defaultEdgeColor: 'rgba(255,255,255,0.12)',
    defaultNodeColor: '#94a3b8',
    labelFont: 'Inter, system-ui, sans-serif',
    labelSize: 11,
    labelWeight: '500',
    labelColor: { color: '#e6edf3' },
    edgeReducer: (_edge, data) => ({
      ...data,
      color: data.highlighted
        ? 'rgba(79,156,249,0.8)'
        : data.isResolved
          ? 'rgba(255,255,255,0.12)'
          : 'rgba(255,255,255,0.03)',
      size: data.highlighted ? Math.max((data.size as number) * 1.8, 2) : data.isResolved ? 1 : 0.5,
    }),
    nodeReducer: (_node, data) => ({
      ...data,
      color: data.highlighted
        ? '#ffffff'
        : data.dimmed
          ? 'rgba(148,163,184,0.15)'
          : data.communityColor ?? data.color,
      size: data.highlighted ? (data.size as number) * 1.4 : data.size,
    }),
  };
}
