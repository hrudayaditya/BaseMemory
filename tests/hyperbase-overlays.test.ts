import { describe, expect, it } from 'vitest';
import {
  computeOverlayMetrics,
  couplingAppearance,
  degreeOverlayColor,
} from '../src/hyperbase/src/lib/overlays';
import { getTheme } from '../src/hyperbase/src/lib/theme';
import type {
  FileGraphNodeAttributes,
  GraphEdgeAttributes,
  SymbolGraphNodeAttributes,
} from '../src/hyperbase/src/types';

type NodeAttributes = FileGraphNodeAttributes | SymbolGraphNodeAttributes;

function createMockGraph(
  nodes: Record<string, NodeAttributes>,
  edges: Array<{ id: string; source: string; target: string; attributes: GraphEdgeAttributes }>
) {
  return {
    forEachNode(callback: (nodeId: string, attributes: NodeAttributes) => void) {
      Object.entries(nodes).forEach(([nodeId, attributes]) => callback(nodeId, attributes));
    },
    inDegree(nodeId: string) {
      return edges.filter((edge) => edge.target === nodeId).length;
    },
    forEachEdge(callback: (edgeId: string, attributes: GraphEdgeAttributes) => void) {
      edges.forEach((edge) => callback(edge.id, edge.attributes));
    },
  };
}

function makeNode(degree: number, filePath = 'src/example.ts'): SymbolGraphNodeAttributes {
  return {
    label: `node-${degree}`,
    color: '#ffffff',
    size: 10,
    x: 0,
    y: 0,
    filePath,
    language: 'typescript',
    kind: 'function',
    degree,
    startLine: 1,
    name: `node-${degree}`,
  };
}

describe('hyperbase overlay helpers', () => {
  it('computes dead nodes from directed in-degree once per graph', () => {
    const graph = createMockGraph(
      {
        a: makeNode(2),
        b: makeNode(2),
        c: makeNode(0),
      },
      [
        {
          id: 'a-b',
          source: 'a',
          target: 'b',
          attributes: { color: '#fff', size: 1, isResolved: true },
        },
      ]
    );

    const metrics = computeOverlayMetrics(graph as never, 'dead');

    expect(Array.from(metrics.deadNodeIds).sort()).toEqual(['a', 'c']);
  });

  it('computes hotspot ids from the highest-degree nodes', () => {
    const graph = createMockGraph(
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `n${index}`,
          makeNode(12 - index, `src/module-${index}.ts`),
        ])
      ),
      []
    );

    const metrics = computeOverlayMetrics(graph as never, 'hotspot');

    expect(metrics.hotspotNodeIds.has('n0')).toBe(true);
    expect(metrics.hotspotNodeIds.has('n9')).toBe(true);
    expect(metrics.hotspotNodeIds.has('n10')).toBe(false);
    expect(metrics.hotspotNodeIds.has('n11')).toBe(false);
  });

  it('interpolates degree colors from the theme scale', () => {
    const theme = getTheme();

    expect(degreeOverlayColor(0, 10, theme)).toBe('rgb(90, 168, 255)');
    expect(degreeOverlayColor(10, 10, theme)).toBe('rgb(255, 122, 26)');
  });

  it('classifies coupling edges by structure and call density', () => {
    const theme = getTheme();

    const sameDirectory = couplingAppearance(
      {
        color: theme.edge.file,
        size: 1,
        isResolved: true,
        callCount: 2,
        callerFilePath: 'src/features/search/query.ts',
        targetFilePath: 'src/features/search/parser.ts',
      },
      10,
      theme
    );

    const crossModule = couplingAppearance(
      {
        color: theme.edge.file,
        size: 1,
        isResolved: true,
        callCount: 3,
        callerFilePath: 'src/features/search/query.ts',
        targetFilePath: 'tests/integration/query.test.ts',
      },
      10,
      theme
    );

    const hotEdge = couplingAppearance(
      {
        color: theme.edge.file,
        size: 1,
        isResolved: true,
        callCount: 9,
        callerFilePath: 'src/features/search/query.ts',
        targetFilePath: 'src/runtime/engine.ts',
      },
      10,
      theme
    );

    expect(sameDirectory.color).toBe(theme.analytics.couplingSame);
    expect(crossModule.color).toBe(theme.analytics.couplingCross);
    expect(hotEdge.color).toBe(theme.analytics.couplingHot);
  });
});
