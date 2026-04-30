import type { Settings } from 'sigma/settings';
import { getTheme, withAlpha } from './theme';
import { couplingAppearance, degreeOverlayColor } from './overlays';
import { languageColor } from './graph-utils';
import type { GraphEdgeAttributes, Overlay, ZoomLevel } from '../types';

export interface RenderSnapshot {
  activeNodeId: string | null;
  selectionNodeId: string | null;
  connectedNodeIds: Set<string>;
  connectedEdgeIds: Set<string>;
  overlay: Overlay;
  focusMode: boolean;
  focusedNodeIds: Set<string>;
  degreeMax: number;
  deadNodeIds: Set<string>;
  hotspotNodeIds: Set<string>;
  edgeCallCountMax: number;
  layoutRunning: boolean;
  settledNodeIds: Set<string>;
  blastRevealDepth: number;
  pulseNodeId: string | null;
  currentView: string;
  zoomLevel: ZoomLevel;
  functionLabelNodeIds: Set<string>;
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
      const highlighted = snapshot.selectionNodeId !== null && snapshot.connectedEdgeIds.has(edge);
      const focusDimmed = snapshot.focusMode && !snapshot.connectedEdgeIds.has(edge);
      const isFunctionView = snapshot.currentView === 'functions';
      const baseAppearance =
        snapshot.overlay === 'coupling'
          ? couplingAppearance(data as GraphEdgeAttributes, snapshot.edgeCallCountMax, theme)
          : {
              color: data.color,
              size: typeof data.size === 'number' ? data.size : data.isResolved ? 1 : 0.5,
            };

      const functionEdgeColor =
        !isFunctionView
          ? baseAppearance.color
          : snapshot.zoomLevel === 'galaxy'
            ? withAlpha(baseAppearance.color, 0.028)
          : snapshot.zoomLevel === 'solar'
            ? withAlpha(baseAppearance.color, 0.09)
            : baseAppearance.color;
      const functionEdgeSize =
        !isFunctionView
          ? baseAppearance.size
          : snapshot.zoomLevel === 'galaxy'
            ? Math.max(baseAppearance.size * 0.16, 0.08)
          : snapshot.zoomLevel === 'solar'
            ? Math.max(baseAppearance.size * 0.42, 0.2)
            : baseAppearance.size;

      return {
        ...data,
        color: highlighted
          ? theme.edge.highlighted
          : snapshot.layoutRunning
            ? withAlpha(functionEdgeColor, 0.18)
          : focusDimmed
            ? theme.edge.unresolved
            : functionEdgeColor,
        size: highlighted ? Math.max(functionEdgeSize * 1.8, 2) : functionEdgeSize,
      };
    },
    nodeReducer: (node, data) => {
      const snapshot = getSnapshot();
      const highlighted = snapshot.activeNodeId !== null && node === snapshot.activeNodeId;
      const dimmed = snapshot.selectionNodeId !== null && !snapshot.connectedNodeIds.has(node);
      const focusDimmed = snapshot.focusMode && !snapshot.focusedNodeIds.has(node);
      const deadDimmed = snapshot.overlay === 'dead' && snapshot.deadNodeIds.has(node);
      const isHotspot = snapshot.overlay === 'hotspot' && snapshot.hotspotNodeIds.has(node);
      const isBlastCenter = typeof data.depth === 'number' && data.depth === 0;
      const hiddenByBlastRipple =
        typeof data.depth === 'number' && data.depth > Math.max(snapshot.blastRevealDepth, 0);
      const pulseTarget = snapshot.pulseNodeId === node;
      const unsettled = snapshot.layoutRunning && !snapshot.settledNodeIds.has(node);
      const isFunctionView = snapshot.currentView === 'functions' && data.entityType === 'symbol';
      const showFunctionLabel =
        !isFunctionView ||
        snapshot.zoomLevel === 'atom' ||
        (snapshot.zoomLevel === 'solar' && snapshot.functionLabelNodeIds.has(node));

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
        : pulseTarget
          ? (data.size as number) * 1.3
        : isHotspot || isBlastCenter
          ? (data.size as number) * 1.35
          : isFunctionView && snapshot.zoomLevel === 'galaxy'
            ? (data.size as number) * 0.78
          : isFunctionView && snapshot.zoomLevel === 'solar'
            ? (data.size as number) * 0.9
          : hiddenByBlastRipple
            ? (data.size as number) * 0.75
            : unsettled
              ? (data.size as number) * 0.9
          : data.size;

      const finalColor =
        highlighted
          ? theme.node.highlight
          : focusDimmed || dimmed || deadDimmed
            ? theme.node.dimmed
            : hiddenByBlastRipple
              ? withAlpha(color, 0.08)
              : unsettled
                ? withAlpha(color, 0.26)
                : color;

      return {
        ...data,
        label: showFunctionLabel ? data.label : '',
        color: finalColor,
        size,
        forceLabel: isHotspot || isBlastCenter,
        highlighted: highlighted || isHotspot || isBlastCenter,
        zIndex: isHotspot || isBlastCenter ? 1 : 0,
      };
    },
  };
}
