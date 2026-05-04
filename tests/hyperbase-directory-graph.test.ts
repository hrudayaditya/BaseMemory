import { describe, expect, it } from 'vitest';
import { buildDirectoryGraphologyInstance, buildOverviewGraphologyInstance } from '../src/hyperbase/src/lib/graph-utils';
import type { DirectoryGraphResponse, OverviewGraphResponse } from '../src/hyperbase/src/types';

describe('overview and module graph builders', () => {
  it('seeds overview directory nodes into a readable ring with directory semantics', () => {
    const payload: OverviewGraphResponse = {
      granularity: 2,
      nodes: [
        {
          id: 'dir::/repo/src/indexer',
          entityType: 'directory',
          name: 'src/indexer',
          filePath: '/repo/src/indexer',
          directory: '/repo/src/indexer',
          directoryPath: '/repo/src/indexer',
          language: 'typescript',
          symbolCount: 180,
          fileCount: 12,
          degree: 8,
        },
        {
          id: 'dir::/repo/src/eval',
          entityType: 'directory',
          name: 'src/eval',
          filePath: '/repo/src/eval',
          directory: '/repo/src/eval',
          directoryPath: '/repo/src/eval',
          language: 'typescript',
          symbolCount: 96,
          fileCount: 8,
          degree: 6,
        },
      ],
      edges: [
        {
          from: 'dir::/repo/src/indexer',
          to: 'dir::/repo/src/eval',
          callCount: 11,
        },
      ],
    };

    const graph = buildOverviewGraphologyInstance(payload, 'g-overview-test');
    const indexer = graph.getNodeAttributes('dir::/repo/src/indexer');
    const evalNode = graph.getNodeAttributes('dir::/repo/src/eval');

    expect(indexer.entityType).toBe('directory');
    expect(evalNode.entityType).toBe('directory');
    expect(Math.hypot(indexer.x, indexer.y)).toBeGreaterThan(180);
    expect(Math.hypot(evalNode.x, evalNode.y)).toBeGreaterThan(180);
  });

  it('keeps external module files on the periphery and internal files centered', () => {
    const payload: DirectoryGraphResponse = {
      directoryPath: '/repo/src/indexer',
      truncated: false,
      nodes: [
        {
          id: 'file::/repo/src/indexer/main.ts',
          entityType: 'file',
          name: 'main.ts',
          filePath: '/repo/src/indexer/main.ts',
          language: 'typescript',
          symbolCount: 12,
          directory: '/repo/src/indexer',
          degree: 5,
          role: 'internal',
        },
        {
          id: 'file::/repo/src/shared/util.ts',
          entityType: 'file',
          name: 'util.ts',
          filePath: '/repo/src/shared/util.ts',
          language: 'typescript',
          symbolCount: 4,
          directory: '/repo/src/shared',
          degree: 2,
          role: 'external-callee',
        },
      ],
      edges: [
        {
          id: 'edge-a',
          from: 'file::/repo/src/indexer/main.ts',
          to: 'file::/repo/src/shared/util.ts',
          callCount: 3,
          boundary: 'outgoing',
          callerFilePath: '/repo/src/indexer/main.ts',
          targetFilePath: '/repo/src/shared/util.ts',
        },
      ],
    };

    const graph = buildDirectoryGraphologyInstance(payload, 'g-module-test');
    const internal = graph.getNodeAttributes('file::/repo/src/indexer/main.ts');
    const external = graph.getNodeAttributes('file::/repo/src/shared/util.ts');

    expect(Math.abs(internal.x)).toBeLessThan(260);
    expect(Math.abs(internal.y)).toBeLessThan(220);
    expect(external.x).toBeGreaterThan(0);
    expect(graph.getEdgeAttributes('edge-a').boundary).toBe('outgoing');
  });
});
