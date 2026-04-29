import { describe, expect, it } from 'vitest';
import { buildDirectoryGraphologyInstance } from '../src/hyperbase/src/lib/graph-utils';
import type { DirectoryGraphResponse } from '../src/hyperbase/src/types';

describe('directory graph builder', () => {
  it('marks internal and external roles with distinct seeded layout regions', () => {
    const payload: DirectoryGraphResponse = {
      directoryPath: '/repo/src/core',
      truncated: false,
      nodes: [
        {
          id: 'internal',
          name: 'buildPerQueryResult',
          kind: 'function',
          filePath: '/repo/src/core/center.ts',
          language: 'typescript',
          startLine: 1,
          degree: 4,
          role: 'internal',
        },
        {
          id: 'incoming',
          name: 'computeMetrics',
          kind: 'function',
          filePath: '/repo/src/callers/caller.ts',
          language: 'typescript',
          startLine: 1,
          degree: 1,
          role: 'external-caller',
        },
        {
          id: 'outgoing',
          name: 'helperAlpha',
          kind: 'function',
          filePath: '/repo/src/helpers/helper.ts',
          language: 'typescript',
          startLine: 1,
          degree: 1,
          role: 'external-callee',
        },
      ],
      edges: [
        {
          id: 'incoming-edge',
          from: 'incoming',
          to: 'internal',
          callType: 'Call',
          isResolved: true,
          callerFilePath: '/repo/src/callers/caller.ts',
          targetFilePath: '/repo/src/core/center.ts',
          boundary: 'incoming',
          line: 1,
        },
        {
          id: 'outgoing-edge',
          from: 'internal',
          to: 'outgoing',
          callType: 'Call',
          isResolved: true,
          callerFilePath: '/repo/src/core/center.ts',
          targetFilePath: '/repo/src/helpers/helper.ts',
          boundary: 'outgoing',
          line: 2,
        },
      ],
    };

    const graph = buildDirectoryGraphologyInstance(payload, 'g-directory-test');
    const internal = graph.getNodeAttributes('internal');
    const incoming = graph.getNodeAttributes('incoming');
    const outgoing = graph.getNodeAttributes('outgoing');

    expect(Math.abs(internal.x)).toBeLessThan(220);
    expect(Math.abs(internal.y)).toBeLessThan(180);
    expect(incoming.x).toBeLessThan(0);
    expect(outgoing.x).toBeGreaterThan(0);
    expect(graph.getEdgeAttributes('incoming-edge').boundary).toBe('incoming');
    expect(graph.getEdgeAttributes('outgoing-edge').boundary).toBe('outgoing');
  });

  it('collapses duplicate directory edges into one rendered edge with aggregated call count', () => {
    const payload: DirectoryGraphResponse = {
      directoryPath: '/repo/src/core',
      truncated: false,
      nodes: [
        {
          id: 'internal',
          name: 'buildPerQueryResult',
          kind: 'function',
          filePath: '/repo/src/core/center.ts',
          language: 'typescript',
          startLine: 1,
          degree: 4,
          role: 'internal',
        },
        {
          id: 'outgoing',
          name: 'helperAlpha',
          kind: 'function',
          filePath: '/repo/src/helpers/helper.ts',
          language: 'typescript',
          startLine: 1,
          degree: 1,
          role: 'external-callee',
        },
      ],
      edges: [
        {
          id: 'duplicate-a',
          from: 'internal',
          to: 'outgoing',
          callType: 'Call',
          isResolved: true,
          callerFilePath: '/repo/src/core/center.ts',
          targetFilePath: '/repo/src/helpers/helper.ts',
          boundary: 'outgoing',
          line: 2,
        },
        {
          id: 'duplicate-b',
          from: 'internal',
          to: 'outgoing',
          callType: 'Call',
          isResolved: true,
          callerFilePath: '/repo/src/core/center.ts',
          targetFilePath: '/repo/src/helpers/helper.ts',
          boundary: 'outgoing',
          line: 9,
        },
      ],
    };

    const graph = buildDirectoryGraphologyInstance(payload, 'g-directory-duplicates');

    expect(graph.size).toBe(1);
    expect(graph.getEdgeAttributes('duplicate-a').callCount).toBe(2);
  });
});
