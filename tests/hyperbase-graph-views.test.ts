import { describe, expect, it } from 'vitest';
import {
  buildBlastRadiusGraphologyInstance,
  buildFullSymbolGraphologyInstance,
  buildPathGraphologyInstance,
} from '../src/hyperbase/src/lib/graph-utils';
import { getTheme } from '../src/hyperbase/src/lib/theme';
import type { BlastRadiusResponse, FullSymbolGraphResponse, GraphEdge, PathNode } from '../src/hyperbase/src/types';

describe('specialized graph builders', () => {
  it('builds blast-radius graphs with depth colors and a highlighted center node', () => {
    const theme = getTheme();
    const payload: BlastRadiusResponse = {
      symbolId: 'sym_center',
      truncated: false,
      depth: {
        sym_center: 0,
        sym_depth_1: 1,
        sym_depth_2: 2,
      },
      nodes: [
        {
          id: 'sym_center',
          entityType: 'symbol',
          name: 'buildPerQueryResult',
          kind: 'function',
          filePath: '/repo/src/core/center.ts',
          language: 'typescript',
          startLine: 1,
          degree: 3,
          depth: 0,
        },
        {
          id: 'sym_depth_1',
          entityType: 'symbol',
          name: 'computeMetrics',
          kind: 'function',
          filePath: '/repo/src/callers/caller.ts',
          language: 'typescript',
          startLine: 1,
          degree: 1,
          depth: 1,
        },
        {
          id: 'sym_depth_2',
          entityType: 'symbol',
          name: 'finalizeEvaluationRun',
          kind: 'function',
          filePath: '/repo/src/callers/runner.ts',
          language: 'typescript',
          startLine: 1,
          degree: 1,
          depth: 2,
        },
      ],
      edges: [
        {
          id: 'edge_1',
          from: 'sym_depth_1',
          to: 'sym_center',
          callType: 'Call',
          isResolved: true,
          callerFilePath: '/repo/src/callers/caller.ts',
          targetFilePath: '/repo/src/core/center.ts',
          line: 1,
        },
        {
          id: 'edge_2',
          from: 'sym_depth_2',
          to: 'sym_depth_1',
          callType: 'Call',
          isResolved: true,
          callerFilePath: '/repo/src/callers/runner.ts',
          targetFilePath: '/repo/src/callers/caller.ts',
          line: 2,
        },
      ],
    };

    const graph = buildBlastRadiusGraphologyInstance(payload, 'g-blast-test');

    expect(graph.getNodeAttributes('sym_center').color).toBe(theme.analytics.hotspot);
    expect(graph.getNodeAttributes('sym_center').depth).toBe(0);
    expect(graph.getNodeAttributes('sym_depth_1').color).toBe(theme.analytics.blastDepth1);
    expect(graph.getNodeAttributes('sym_depth_2').color).toBe(theme.analytics.blastDepth2);
  });

  it('builds path graphs with linear x positions and path-highlighted edges', () => {
    const theme = getTheme();
    const nodes: PathNode[] = [
      { id: 'a', name: 'caller', filePath: '/repo/src/a.ts' },
      { id: 'b', name: 'center', filePath: '/repo/src/b.ts' },
      { id: 'c', name: 'callee', filePath: '/repo/src/c.ts' },
    ];
    const edges: GraphEdge[] = [
      {
        id: 'ab',
        from: 'a',
        to: 'b',
        callType: 'Call',
        isResolved: true,
        callerFilePath: '/repo/src/a.ts',
        targetFilePath: '/repo/src/b.ts',
        line: 1,
      },
      {
        id: 'bc',
        from: 'b',
        to: 'c',
        callType: 'Call',
        isResolved: true,
        callerFilePath: '/repo/src/b.ts',
        targetFilePath: '/repo/src/c.ts',
        line: 2,
      },
    ];

    const graph = buildPathGraphologyInstance(nodes, edges, 'g-path-test');

    expect(graph.getNodeAttributes('a').x).toBeLessThan(graph.getNodeAttributes('b').x);
    expect(graph.getNodeAttributes('b').x).toBeLessThan(graph.getNodeAttributes('c').x);
    expect(graph.getEdgeAttributes('ab').color).toBe(theme.edge.path);
    expect(graph.getEdgeAttributes('bc').color).toBe(theme.edge.path);
  });

  it('builds full-symbol graphs with clustered file seeding and collapsed duplicate edges', () => {
    const payload: FullSymbolGraphResponse = {
      truncated: false,
      nodes: [
        {
          id: 'sym_a1',
          entityType: 'symbol',
          name: 'alpha',
          kind: 'function',
          filePath: '/repo/src/a.ts',
          language: 'typescript',
          startLine: 1,
          degree: 3,
        },
        {
          id: 'sym_a2',
          entityType: 'symbol',
          name: 'beta',
          kind: 'function',
          filePath: '/repo/src/a.ts',
          language: 'typescript',
          startLine: 12,
          degree: 2,
        },
        {
          id: 'sym_b1',
          entityType: 'symbol',
          name: 'gamma',
          kind: 'function',
          filePath: '/repo/src/b.ts',
          language: 'typescript',
          startLine: 2,
          degree: 1,
        },
      ],
      edges: [
        {
          id: 'edge_1',
          from: 'sym_a1',
          to: 'sym_b1',
          callType: 'Call',
          isResolved: true,
          callerFilePath: '/repo/src/a.ts',
          targetFilePath: '/repo/src/b.ts',
          line: 3,
        },
        {
          id: 'edge_2',
          from: 'sym_a1',
          to: 'sym_b1',
          callType: 'Call',
          isResolved: true,
          callerFilePath: '/repo/src/a.ts',
          targetFilePath: '/repo/src/b.ts',
          line: 8,
        },
      ],
    };

    const graph = buildFullSymbolGraphologyInstance(payload, 'g-full-symbol-test');
    const a1 = graph.getNodeAttributes('sym_a1');
    const a2 = graph.getNodeAttributes('sym_a2');
    const b1 = graph.getNodeAttributes('sym_b1');

    const intraFileDistance = Math.hypot(a1.x - a2.x, a1.y - a2.y);
    const interFileDistance = Math.hypot(a1.x - b1.x, a1.y - b1.y);

    expect(interFileDistance).toBeGreaterThan(intraFileDistance);
    expect(graph.size).toBe(1);
    const edgeKey = graph.edges()[0];
    expect(graph.getEdgeAttributes(edgeKey).callCount).toBe(2);
  });
});
