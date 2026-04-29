import Graph from 'graphology';
import type Sigma from 'sigma';
import { derived, get, writable } from 'svelte/store';
import { fetchBranches, fetchFullGraph, fetchNeighborhood, isAbortError } from '../api/client';
import { buildGraphologyInstance, buildNeighborhoodGraphologyInstance } from '../lib/graph-utils';
import { restoreLayoutSnapshot } from '../lib/layout-cache';
import { communityColorFor } from '../lib/theme';
import type {
  FileEdge,
  FileGraphNodeAttributes,
  FileNode,
  FullGraphResponse,
  GraphEdgeAttributes,
  NeighborhoodResponse,
  Overlay,
  SymbolGraphNodeAttributes,
  UrlState,
  ZoomLevel,
} from '../types';
import { activeOverlay, graphDepth } from './ui';
export { graphDepth } from './ui';

type GraphLoadTarget =
  | {
      kind: 'galaxy';
      branch: string;
    }
  | {
      kind: 'neighborhood';
      branch: string;
      symbolId: string;
      depth: number;
    };

type HyperGraph = Graph<FileGraphNodeAttributes | SymbolGraphNodeAttributes, GraphEdgeAttributes>;

export const graphInstance = writable<HyperGraph | null>(null);
export const sigmaInstance = writable<Sigma | null>(null);

export const fileNodes = writable<FileNode[]>([]);
export const fileEdges = writable<FileEdge[]>([]);

export const graphLoading = writable<boolean>(false);
export const graphError = writable<string | null>(null);
export const graphTruncated = writable<boolean>(false);

export const activeBranch = writable<string>('');
export const availableBranches = writable<string[]>([]);
export const focusedSymbolId = writable<string | null>(null);
export const zoomLevel = writable<ZoomLevel>('galaxy');

export const graphNodeCount = writable<number>(0);
export const graphEdgeCount = writable<number>(0);
export const graphLoadId = writable<number>(0);
export const graphContentId = writable<string | null>(null);
export const graphLayoutCacheHit = writable<boolean>(false);
export const graphRefreshNonce = writable<number>(0);

export const cameraState = writable<{ x: number; y: number; ratio: number; angle: number }>({
  x: 0.5,
  y: 0.5,
  ratio: 1,
  angle: 0,
});

export const graphStats = derived(
  [graphNodeCount, graphEdgeCount],
  ([$nodeCount, $edgeCount]) => ({ nodeCount: $nodeCount, edgeCount: $edgeCount })
);

function stableHash(parts: string[]): string {
  let hash = 2166136261;
  const joined = parts.join('|');
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `g${(hash >>> 0).toString(36)}`;
}

function createGraphContentId(target: GraphLoadTarget, nodes: string[], edges: string[]): string {
  const head =
    target.kind === 'galaxy'
      ? [`view:${target.kind}`, `branch:${target.branch}`]
      : [`view:${target.kind}`, `branch:${target.branch}`, `symbol:${target.symbolId}`, `depth:${target.depth}`];

  return stableHash([...head, ...nodes, ...edges]);
}

function fullGraphContentId(target: GraphLoadTarget, payload: FullGraphResponse): string {
  const nodeKeys = payload.nodes
    .map((node) => `${node.id}:${node.filePath}:${node.language}:${node.symbolCount}`)
    .sort();
  const edgeKeys = payload.edges.map((edge) => `${edge.from}:${edge.to}:${edge.callCount}`).sort();
  return createGraphContentId(target, nodeKeys, edgeKeys);
}

function neighborhoodGraphContentId(target: GraphLoadTarget, payload: NeighborhoodResponse): string {
  const nodeKeys = payload.nodes.map((node) => `${node.id}:${node.name}:${node.degree}`).sort();
  const edgeKeys = payload.edges.map((edge) => `${edge.id}:${edge.from}:${edge.to ?? 'null'}:${edge.isResolved}`).sort();
  return createGraphContentId(target, nodeKeys, edgeKeys);
}

function nextRevision(counter: number): number {
  return counter + 1;
}

class GraphController {
  private initialized = false;
  private graphAbortController: AbortController | null = null;
  private branchesAbortController: AbortController | null = null;
  private communityWorker: Worker | null = null;
  private graphRequestRevision = 0;
  private graphLoadRevision = 0;
  private communityComputedForLoadId: number | null = null;
  private currentTarget: GraphLoadTarget | null = null;
  private lastUrlState: UrlState = {};

  async initialize(initialUrlState: UrlState = {}): Promise<void> {
    this.lastUrlState = initialUrlState;
    this.branchesAbortController?.abort();
    const branchesAbortController = new AbortController();
    this.branchesAbortController = branchesAbortController;

    graphLoading.set(true);
    graphError.set(null);

    try {
      const branches = await fetchBranches(branchesAbortController.signal);
      if (branchesAbortController.signal.aborted) {
        return;
      }

      availableBranches.set(branches);

      const requestedBranch = initialUrlState.branch;
      const branch = requestedBranch && branches.includes(requestedBranch) ? requestedBranch : branches[0] ?? '';
      const depth = initialUrlState.depth && [1, 2, 3].includes(initialUrlState.depth) ? initialUrlState.depth : 1;

      activeBranch.set(branch);
      graphDepth.set(depth);
      this.initialized = true;

      if (initialUrlState.symbolId) {
        await this.loadNeighborhood(initialUrlState.symbolId, { branch, depth });
      } else {
        await this.loadGalaxy(branch);
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      graphError.set(error instanceof Error ? error.message : 'Failed to initialize graph');
      graphLoading.set(false);
    } finally {
      if (this.branchesAbortController === branchesAbortController) {
        this.branchesAbortController = null;
      }
    }
  }

  async loadGalaxy(branch = get(activeBranch)): Promise<void> {
    if (!branch) {
      graphError.set('No active branch selected');
      return;
    }

    const target: GraphLoadTarget = { kind: 'galaxy', branch };
    this.currentTarget = target;
    this.lastUrlState = { branch, view: 'galaxy' };

    const load = this.beginGraphLoad();

    try {
      const payload = await fetchFullGraph(branch, load.abortController.signal);
      if (!this.isActiveGraphLoad(load.revision, load.abortController.signal)) {
        return;
      }

      const contentId = fullGraphContentId(target, payload);
      const graph = buildGraphologyInstance(payload.nodes, payload.edges, contentId);
      const layoutCacheHit = restoreLayoutSnapshot(graph, contentId);
      this.commitGraphLoad({
        graph,
        target,
        contentId,
        layoutCacheHit,
        nodeCount: payload.nodes.length,
        edgeCount: payload.edges.length,
        truncated: false,
        fileGraph: payload,
      });
    } catch (error) {
      this.handleGraphLoadError(error, load.revision);
    }
  }

  async loadNeighborhood(
    symbolId: string,
    options: {
      branch?: string;
      depth?: number;
    } = {}
  ): Promise<void> {
    const branch = options.branch ?? get(activeBranch);
    const depth = options.depth ?? get(graphDepth);

    if (!symbolId || !branch) {
      graphError.set('Cannot load neighborhood without a symbol and branch');
      return;
    }

    const target: GraphLoadTarget = {
      kind: 'neighborhood',
      branch,
      symbolId,
      depth,
    };

    this.currentTarget = target;
    this.lastUrlState = {
      branch,
      symbolId,
      depth,
      view: 'atom',
    };

    const load = this.beginGraphLoad();

    try {
      const payload = await fetchNeighborhood(symbolId, branch, depth, load.abortController.signal);
      if (!this.isActiveGraphLoad(load.revision, load.abortController.signal)) {
        return;
      }

      const contentId = neighborhoodGraphContentId(target, payload);
      const graph = buildNeighborhoodGraphologyInstance(payload.nodes, payload.edges, contentId);
      const layoutCacheHit = restoreLayoutSnapshot(graph, contentId);
      this.commitGraphLoad({
        graph,
        target,
        contentId,
        layoutCacheHit,
        nodeCount: payload.nodes.length,
        edgeCount: payload.edges.length,
        truncated: payload.truncated,
      });
    } catch (error) {
      this.handleGraphLoadError(error, load.revision);
    }
  }

  async changeBranch(branch: string): Promise<void> {
    activeBranch.set(branch);
    if (!this.initialized) {
      return;
    }

    if (this.currentTarget?.kind === 'neighborhood') {
      await this.loadNeighborhood(this.currentTarget.symbolId, {
        branch,
        depth: get(graphDepth),
      });
      return;
    }

    await this.loadGalaxy(branch);
  }

  async changeDepth(depth: number): Promise<void> {
    graphDepth.set(depth);
    if (!this.initialized || this.currentTarget?.kind !== 'neighborhood') {
      return;
    }

    await this.loadNeighborhood(this.currentTarget.symbolId, {
      branch: get(activeBranch),
      depth,
    });
  }

  async retry(): Promise<void> {
    if (!this.initialized) {
      await this.initialize(this.lastUrlState);
      return;
    }

    if (this.currentTarget?.kind === 'neighborhood') {
      await this.loadNeighborhood(this.currentTarget.symbolId, {
        branch: this.currentTarget.branch,
        depth: this.currentTarget.depth,
      });
      return;
    }

    if (this.currentTarget?.kind === 'galaxy') {
      await this.loadGalaxy(this.currentTarget.branch);
      return;
    }

    const branch = get(activeBranch);
    if (branch) {
      await this.loadGalaxy(branch);
    }
  }

  setOverlay(overlay: Overlay): void {
    activeOverlay.set(overlay);
    if (overlay === 'community') {
      const graph = get(graphInstance);
      const loadId = get(graphLoadId);
      if (graph && loadId > 0) {
        this.computeCommunities(graph, loadId);
      }
    }
  }

  private beginGraphLoad(): { revision: number; abortController: AbortController } {
    this.graphAbortController?.abort();
    const abortController = new AbortController();
    this.graphAbortController = abortController;
    const revision = nextRevision(this.graphRequestRevision);
    this.graphRequestRevision = revision;

    graphLoading.set(true);
    graphError.set(null);

    return { revision, abortController };
  }

  private isActiveGraphLoad(revision: number, signal: AbortSignal): boolean {
    return !signal.aborted && this.graphRequestRevision === revision;
  }

  private commitGraphLoad(options: {
    graph: HyperGraph;
    target: GraphLoadTarget;
    contentId: string;
    layoutCacheHit: boolean;
    nodeCount: number;
    edgeCount: number;
    truncated: boolean;
    fileGraph?: FullGraphResponse;
  }): void {
    if (options.fileGraph) {
      fileNodes.set(options.fileGraph.nodes);
      fileEdges.set(options.fileGraph.edges);
    } else {
      fileNodes.set([]);
      fileEdges.set([]);
    }

    this.graphLoadRevision = nextRevision(this.graphLoadRevision);
    this.communityComputedForLoadId = null;

    graphInstance.set(options.graph);
    graphContentId.set(options.contentId);
    graphLayoutCacheHit.set(options.layoutCacheHit);
    graphLoadId.set(this.graphLoadRevision);
    graphNodeCount.set(options.nodeCount);
    graphEdgeCount.set(options.edgeCount);
    graphTruncated.set(options.truncated);
    focusedSymbolId.set(options.target.kind === 'neighborhood' ? options.target.symbolId : null);
    graphLoading.set(false);

    if (get(activeOverlay) === 'community') {
      this.computeCommunities(options.graph, this.graphLoadRevision);
    }
  }

  private handleGraphLoadError(error: unknown, revision: number): void {
    if (isAbortError(error)) {
      if (this.graphRequestRevision === revision) {
        graphLoading.set(false);
      }
      return;
    }

    if (this.graphRequestRevision !== revision) {
      return;
    }

    graphError.set(error instanceof Error ? error.message : 'Failed to load graph');
    graphLoading.set(false);
  }

  private computeCommunities(graph: HyperGraph, loadId: number): void {
    if (this.communityComputedForLoadId === loadId) {
      return;
    }

    this.communityWorker?.terminate();
    const worker = new Worker(new URL('../workers/layout.worker.ts', import.meta.url), { type: 'module' });
    this.communityWorker = worker;

    worker.onmessage = (event: MessageEvent<{ type: 'communities'; communities: Record<string, number> }>) => {
      if (event.data.type !== 'communities' || get(graphLoadId) !== loadId) {
        return;
      }

      Object.entries(event.data.communities).forEach(([nodeId, community]) => {
        if (!graph.hasNode(nodeId)) {
          return;
        }

        graph.mergeNodeAttributes(nodeId, {
          community,
          communityColor: communityColorFor(String(community)),
        });
      });

      this.communityComputedForLoadId = loadId;
      graphRefreshNonce.update((value) => value + 1);
      worker.terminate();
      if (this.communityWorker === worker) {
        this.communityWorker = null;
      }
    };

    worker.postMessage({
      type: 'communities',
      graph: graph.export(),
    });
  }
}

const graphController = new GraphController();

export const initializeGraph = (initialUrlState?: UrlState) => graphController.initialize(initialUrlState);
export const loadGalaxyGraph = (branch?: string) => graphController.loadGalaxy(branch);
export const loadNeighborhoodGraph = (symbolId: string, options?: { branch?: string; depth?: number }) =>
  graphController.loadNeighborhood(symbolId, options);
export const changeActiveBranch = (branch: string) => graphController.changeBranch(branch);
export const changeGraphDepth = (depth: number) => graphController.changeDepth(depth);
export const retryGraphLoad = () => graphController.retry();
export const setGraphOverlay = (overlay: Overlay) => graphController.setOverlay(overlay);
