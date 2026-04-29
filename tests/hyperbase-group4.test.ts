import Graph from '../src/hyperbase/node_modules/graphology';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateHandoffReport } from '../src/hyperbase/src/lib/handoff-report';
import { readUrlState, writeUrlState } from '../src/hyperbase/src/lib/url-state';
import type {
  CurrentGraphPayload,
  GraphEdgeAttributes,
  NeighborhoodResponse,
  SymbolGraphNodeAttributes,
} from '../src/hyperbase/src/types';

describe('group 4 collaboration helpers', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips focus-mode url state', () => {
    const history = { replaceState: vi.fn() };
    const location = { hash: '#branch=main&focus=1&focused=a,b&view=atom' };
    vi.stubGlobal('window', { location, localStorage: { getItem: vi.fn(), setItem: vi.fn() } });
    vi.stubGlobal('history', history);

    const parsed = readUrlState();
    expect(parsed.focus).toBe(true);
    expect(parsed.focusedIds).toEqual(['a', 'b']);

    writeUrlState({
      branch: 'main',
      view: 'atom',
      focus: true,
      focusedIds: ['sym_a', 'sym_b'],
    });

    expect(history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      '#branch=main&focus=1&focused=sym_a%2Csym_b&view=atom'
    );
  });

  it('generates a handoff report with external callers, callees, and unresolved edges', () => {
    const graph = new Graph<SymbolGraphNodeAttributes, GraphEdgeAttributes>({ type: 'directed', multi: false });
    graph.addNode('center', {
      label: 'buildPerQueryResult',
      name: 'buildPerQueryResult',
      color: '#fff',
      size: 8,
      x: 0,
      y: 0,
      filePath: '/repo/src/core/center.ts',
      language: 'typescript',
      kind: 'function',
      degree: 3,
      startLine: 1,
    });
    graph.addNode('caller', {
      label: 'computeMetrics',
      name: 'computeMetrics',
      color: '#fff',
      size: 6,
      x: -10,
      y: 0,
      filePath: '/repo/src/callers/caller.ts',
      language: 'typescript',
      kind: 'function',
      degree: 1,
      startLine: 1,
    });
    graph.addNode('callee', {
      label: 'helperAlpha',
      name: 'helperAlpha',
      color: '#fff',
      size: 6,
      x: 10,
      y: 0,
      filePath: '/repo/src/helpers/helper.ts',
      language: 'typescript',
      kind: 'function',
      degree: 1,
      startLine: 1,
    });
    graph.addEdgeWithKey('caller-center', 'caller', 'center', { color: '#fff', size: 1, isResolved: true });
    graph.addEdgeWithKey('center-callee', 'center', 'callee', { color: '#fff', size: 1, isResolved: true });

    const payload: CurrentGraphPayload = {
      kind: 'neighborhood',
      payload: {
        centerSymbolId: 'center',
        depth: 1,
        truncated: false,
        nodes: [
          { id: 'center', name: 'buildPerQueryResult', kind: 'function', filePath: '/repo/src/core/center.ts', language: 'typescript', startLine: 1, degree: 3 },
          { id: 'caller', name: 'computeMetrics', kind: 'function', filePath: '/repo/src/callers/caller.ts', language: 'typescript', startLine: 1, degree: 1 },
          { id: 'callee', name: 'helperAlpha', kind: 'function', filePath: '/repo/src/helpers/helper.ts', language: 'typescript', startLine: 1, degree: 1 },
        ],
        edges: [
          { id: 'caller-center', from: 'caller', to: 'center', callType: 'Call', isResolved: true, callerFilePath: '/repo/src/callers/caller.ts', targetFilePath: '/repo/src/core/center.ts', line: 1 },
          { id: 'center-callee', from: 'center', to: 'callee', callType: 'Call', isResolved: true, callerFilePath: '/repo/src/core/center.ts', targetFilePath: '/repo/src/helpers/helper.ts', line: 2 },
          { id: 'center-ghost', from: 'center', to: null, callType: 'Call', isResolved: false, callerFilePath: '/repo/src/core/center.ts', targetFilePath: null, line: 9 },
        ],
      } satisfies NeighborhoodResponse,
    };

    const report = generateHandoffReport(['center'], graph, payload, {
      kind: 'atom',
      symbolId: 'center',
      symbolName: 'buildPerQueryResult',
    });

    expect(report.title).toContain('buildPerQueryResult');
    expect(report.markdown).toContain('This subsystem has 1 symbols');
    expect(report.markdown).toContain('`computeMetrics`');
    expect(report.markdown).toContain('`helperAlpha`');
    expect(report.markdown).toContain('Unresolved Edges');
  });
});
