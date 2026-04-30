import type { Settings } from 'sigma/settings';
import { getTheme } from './theme';
import { couplingAppearance, degreeOverlayColor } from './overlays';
import { languageColor } from './graph-utils';
import type { GraphEdgeAttributes, Overlay } from '../types';

export interface RenderSnapshot {
  activeNodeId: string | null;
  connectedNodeIds: Set<string>;
  connectedEdgeIds: Set<string>;
  overlay: Overlay;
  focusMode: boolean;
  focusedNodeIds: Set<string>;
  degreeMax: number;
  deadNodeIds: Set<string>;
  hotspotNodeIds: Set<string>;
  edgeCallCountMax: number;
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
      const focusDimmed = snapshot.focusMode && !snapshot.connectedEdgeIds.has(edge);
      const baseAppearance =
        snapshot.overlay === 'coupling'
          ? couplingAppearance(data as GraphEdgeAttributes, snapshot.edgeCallCountMax, theme)
          : {
              color: data.color,
              size: typeof data.size === 'number' ? data.size : data.isResolved ? 1 : 0.5,
            };

      return {
        ...data,
        color: highlighted
          ? theme.edge.highlighted
          : focusDimmed
            ? theme.edge.unresolved
            : baseAppearance.color,
        size: highlighted ? Math.max(baseAppearance.size * 1.8, 2) : baseAppearance.size,
      };
    },
    nodeReducer: (node, data) => {
      const snapshot = getSnapshot();
      const highlighted = snapshot.activeNodeId !== null && node === snapshot.activeNodeId;
      const dimmed = snapshot.activeNodeId !== null && !snapshot.connectedNodeIds.has(node);
      const focusDimmed = snapshot.focusMode && !snapshot.focusedNodeIds.has(node);
      const deadDimmed = snapshot.overlay === 'dead' && snapshot.deadNodeIds.has(node);
      const isHotspot = snapshot.overlay === 'hotspot' && snapshot.hotspotNodeIds.has(node);
      const isBlastCenter = typeof data.depth === 'number' && data.depth === 0;

      const color =
        snapshot.overlay === 'community' && typeof data.communityColor === 'string'
          ? data.communityColor
          : snapshot.overlay === 'degree'
            ? degreeOverlayColor(typeof data.degree === 'number' ? data.degree : 0, snapshot.degreeMax, theme)
            : snapshot.overlay === 'language'
              ? languageColor(typeof data.language === 'string' ? data.language : 'default')
              : isHotspot
                ? theme.analytics.hotspot
                : data.color;

      const size = highlighted
        ? (data.size as number) * 1.4
        : isHotspot || isBlastCenter
          ? (data.size as number) * 1.35
          : data.size;

      return {
        ...data,
        color: highlighted ? theme.node.highlight : focusDimmed || dimmed || deadDimmed ? theme.node.dimmed : color,
        size,
        forceLabel: isHotspot || isBlastCenter,
        highlighted: highlighted || isHotspot || isBlastCenter,
        zIndex: isHotspot || isBlastCenter ? 1 : 0,
      };
    },
  };
}
