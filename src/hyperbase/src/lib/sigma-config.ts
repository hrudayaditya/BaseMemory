import type { Settings } from 'sigma/settings';

export interface RenderSnapshot {
  activeNodeId: string | null;
  connectedNodeIds: Set<string>;
  connectedEdgeIds: Set<string>;
  overlay: string;
}

export function buildSigmaSettings(getSnapshot: () => RenderSnapshot): Partial<Settings> {
  return {
    renderEdgeLabels: false,
    defaultEdgeColor: 'rgba(255,255,255,0.12)',
    defaultNodeColor: '#94a3b8',
    labelFont: 'Inter, system-ui, sans-serif',
    labelSize: 11,
    labelWeight: '500',
    labelColor: { color: '#e6edf3' },
    edgeReducer: (edge, data) => {
      const snapshot = getSnapshot();
      const highlighted = snapshot.activeNodeId !== null && snapshot.connectedEdgeIds.has(edge);

      return {
        ...data,
        color: highlighted
          ? 'rgba(79,156,249,0.8)'
          : data.isResolved
            ? 'rgba(255,255,255,0.12)'
            : 'rgba(255,255,255,0.03)',
        size: highlighted ? Math.max((data.size as number) * 1.8, 2) : data.isResolved ? 1 : 0.5,
      };
    },
    nodeReducer: (node, data) => {
      const snapshot = getSnapshot();
      const highlighted = snapshot.activeNodeId !== null && node === snapshot.activeNodeId;
      const dimmed = snapshot.activeNodeId !== null && !snapshot.connectedNodeIds.has(node);
      const color = snapshot.overlay === 'community' && typeof data.communityColor === 'string' ? data.communityColor : data.color;

      return {
        ...data,
        color: highlighted ? '#ffffff' : dimmed ? 'rgba(148,163,184,0.15)' : color,
        size: highlighted ? (data.size as number) * 1.4 : data.size,
      };
    },
  };
}
