import type { Settings } from 'sigma/settings';
import { getTheme } from './theme';

export interface RenderSnapshot {
  activeNodeId: string | null;
  connectedNodeIds: Set<string>;
  connectedEdgeIds: Set<string>;
  overlay: string;
}

export function buildSigmaSettings(getSnapshot: () => RenderSnapshot): Partial<Settings> {
  const theme = getTheme();

  return {
    renderEdgeLabels: false,
    defaultEdgeColor: theme.edge.default,
    defaultNodeColor: theme.node.default,
    labelFont: 'Inter, system-ui, sans-serif',
    labelSize: 11,
    labelWeight: '500',
    labelColor: { color: theme.text.primary },
    edgeReducer: (edge, data) => {
      const snapshot = getSnapshot();
      const highlighted = snapshot.activeNodeId !== null && snapshot.connectedEdgeIds.has(edge);

      return {
        ...data,
        color: highlighted ? theme.edge.highlighted : data.isResolved ? theme.edge.default : theme.edge.unresolved,
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
        color: highlighted ? theme.node.highlight : dimmed ? theme.node.dimmed : color,
        size: highlighted ? (data.size as number) * 1.4 : data.size,
      };
    },
  };
}
