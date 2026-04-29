import type Graph from 'graphology';
import {
  COUPLING_CROSS_MODULE_SIZE,
  COUPLING_HIGH_CALL_RATIO,
  COUPLING_HIGH_CALL_SIZE,
  COUPLING_SAME_DIRECTORY_SIZE,
  HOTSPOT_NODE_COUNT,
} from './constants';
import { getTheme, type HyperbaseTheme } from './theme';
import type {
  FileGraphNodeAttributes,
  GraphEdgeAttributes,
  Overlay,
  SymbolGraphNodeAttributes,
} from '../types';

type HyperGraph = Graph<FileGraphNodeAttributes | SymbolGraphNodeAttributes, GraphEdgeAttributes>;

export interface OverlayMetrics {
  degreeMax: number;
  deadNodeIds: Set<string>;
  hotspotNodeIds: Set<string>;
  edgeCallCountMax: number;
}

export const EMPTY_OVERLAY_METRICS: OverlayMetrics = {
  degreeMax: 1,
  deadNodeIds: new Set<string>(),
  hotspotNodeIds: new Set<string>(),
  edgeCallCountMax: 1,
};

type RgbColor = { r: number; g: number; b: number };

function parseRgbColor(color: string): RgbColor {
  const normalized = color.trim();

  if (normalized.startsWith('#')) {
    const hex = normalized.slice(1);
    if (hex.length === 3) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16),
      };
    }

    if (hex.length === 6) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      };
    }
  }

  const match = normalized.match(/rgba?\(([^)]+)\)/i);
  if (match) {
    const [r = 0, g = 0, b = 0] = match[1]
      .split(',')
      .slice(0, 3)
      .map((value) => Number.parseFloat(value.trim()));
    return { r, g, b };
  }

  return { r: 148, g: 163, b: 184 };
}

function mixColor(from: string, to: string, ratio: number): string {
  const start = parseRgbColor(from);
  const end = parseRgbColor(to);
  const t = Math.min(Math.max(ratio, 0), 1);
  const channel = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${channel(start.r, end.r)}, ${channel(start.g, end.g)}, ${channel(start.b, end.b)})`;
}

function nodeDegree(nodeData: FileGraphNodeAttributes | SymbolGraphNodeAttributes): number {
  return typeof nodeData.degree === 'number' ? nodeData.degree : 0;
}

function normalizePath(filePath: string | null | undefined): string {
  return (filePath ?? '').replace(/\\/g, '/').trim();
}

function parentDirectory(filePath: string | null | undefined): string {
  const normalized = normalizePath(filePath);
  if (!normalized) {
    return '';
  }
  const parts = normalized.split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}

export function topLevelDirectory(filePath: string | null | undefined): string {
  const normalized = normalizePath(filePath);
  if (!normalized) {
    return '';
  }

  const parts = normalized.split('/').filter(Boolean);
  return parts[0] ?? '';
}

export function degreeOverlayColor(
  degree: number,
  degreeMax: number,
  theme: HyperbaseTheme = getTheme()
): string {
  const normalized = degreeMax <= 0 ? 0 : Math.min(Math.max(degree / degreeMax, 0), 1);
  return mixColor(theme.analytics.degreeLow, theme.analytics.degreeHigh, normalized);
}

export function couplingAppearance(
  edgeData: GraphEdgeAttributes,
  edgeCallCountMax: number,
  theme: HyperbaseTheme = getTheme()
): { color: string; size: number } {
  const baseSize = typeof edgeData.size === 'number' ? edgeData.size : 1;
  const callerDirectory = parentDirectory(edgeData.callerFilePath);
  const targetDirectory = parentDirectory(edgeData.targetFilePath);
  const sameDirectory = callerDirectory.length > 0 && callerDirectory === targetDirectory;
  const crossTopLevel =
    topLevelDirectory(edgeData.callerFilePath).length > 0 &&
    topLevelDirectory(edgeData.callerFilePath) !== topLevelDirectory(edgeData.targetFilePath);
  const callCount = edgeData.callCount ?? 1;
  const hotThreshold = Math.max(edgeCallCountMax, 1) * COUPLING_HIGH_CALL_RATIO;

  if (callCount >= hotThreshold && edgeCallCountMax > 1) {
    return {
      color: theme.analytics.couplingHot,
      size: Math.max(baseSize, COUPLING_HIGH_CALL_SIZE),
    };
  }

  if (sameDirectory) {
    return {
      color: theme.analytics.couplingSame,
      size: Math.min(baseSize, COUPLING_SAME_DIRECTORY_SIZE),
    };
  }

  if (crossTopLevel) {
    return {
      color: theme.analytics.couplingCross,
      size: Math.max(baseSize, COUPLING_CROSS_MODULE_SIZE),
    };
  }

  return {
    color: edgeData.color,
    size: baseSize,
  };
}

export function computeOverlayMetrics(graph: HyperGraph | null, overlay: Overlay): OverlayMetrics {
  if (!graph) {
    return {
      degreeMax: 1,
      deadNodeIds: new Set<string>(),
      hotspotNodeIds: new Set<string>(),
      edgeCallCountMax: 1,
    };
  }

  const degreeSensitive = overlay === 'degree' || overlay === 'hotspot';
  let degreeMax = 1;
  const deadNodeIds = new Set<string>();
  const hotspotNodeIds = new Set<string>();
  const rankedNodes: Array<{ id: string; degree: number }> = [];

  graph.forEachNode((nodeId, attributes) => {
    const degree = nodeDegree(attributes);
    if (degreeSensitive) {
      degreeMax = Math.max(degreeMax, degree);
      rankedNodes.push({ id: nodeId, degree });
    }

    if (overlay === 'dead' && graph.inDegree(nodeId) === 0) {
      deadNodeIds.add(nodeId);
    }
  });

  if (overlay === 'hotspot') {
    rankedNodes
      .sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id))
      .slice(0, HOTSPOT_NODE_COUNT)
      .forEach(({ id }) => hotspotNodeIds.add(id));
  }

  let edgeCallCountMax = 1;
  if (overlay === 'coupling') {
    graph.forEachEdge((_edgeId, attributes) => {
      edgeCallCountMax = Math.max(edgeCallCountMax, attributes.callCount ?? 1);
    });
  }

  return {
    degreeMax,
    deadNodeIds,
    hotspotNodeIds,
    edgeCallCountMax,
  };
}
