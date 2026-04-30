import Graph from 'graphology';
import type Sigma from 'sigma';
import { derived, get, writable } from 'svelte/store';
import {
  fetchBlastRadius,
  fetchBranches,
  fetchDbInfo,
  fetchDemoRepos,
  fetchDirectoryGraph,
  fetchFileGraph,
  fetchFullGraph,
  fetchNeighborhood,
  fetchOverviewGraph,
  fetchPath,
  isAbortError,
  selectDemoDatabase,
  uploadDatabase,
} from '../api/client';
import {
  buildBlastRadiusGraphologyInstance,
  buildDirectoryGraphologyInstance,
  buildFileGraphologyInstance,
  buildGraphologyInstance,
  buildNeighborhoodGraphologyInstance,
  buildOverviewGraphologyInstance,
  buildPathGraphologyInstance,
} from '../lib/graph-utils';
import { restoreLayoutSnapshot } from '../lib/layout-cache';
import { communityColorFor } from '../lib/theme';
import type {
  BlastRadiusResponse,
  CurrentGraphPayload,
  DbInfoResponse,
  DemoRepoInfo,
  DirectoryGraphResponse,
  FileGraphResponse,
  FileEdge,
  FileGraphNodeAttributes,
  FileNode,
  FullGraphResponse,
  GraphEdgeAttributes,
  NeighborhoodResponse,
  Overlay,
  OverviewGraphResponse,
  PathResponse,
  SymbolGraphNodeAttributes,
  UrlState,
  ZoomLevel,
} from '../types';
import { activeOverlay, graphDepth } from './ui';
export { graphDepth } from './ui';

type GraphLoadTarget =
  | {
      kind: 'overview';
      branch: string;
    }
  | {
      kind: 'galaxy';
      branch: string;
    }
  | {
      kind: 'neighborhood';
      branch: string;
      symbolId: string;
      depth: number;
    }
  | {
      kind: 'blast-radius';
      branch: string;
      symbolId: string;
    }
  | {
      kind: 'path';
      branch: string;
      fromId: string;
      toId: string;
    }
  | {
      kind: 'directory';
      branch: string;
      directoryPath: string;
    }
  | {
      kind: 'file';
      branch: string;
      filePath: string;
    };

export type ViewInfo =
  | { kind: 'overview'; granularity: number }
  | { kind: 'galaxy' }
  | { kind: 'atom'; mode: 'symbol' | 'file'; symbolId?: string; symbolName?: string; filePath?: string; directoryPath?: string }
  | { kind: 'blast'; symbolId: string; symbolName: string; truncated: boolean }
  | { kind: 'path'; fromId: string; toId: string; fromName: string; toName: string; hopCount: number; found: boolean; exhausted: boolean }
  | { kind: 'directory'; directoryPath: string; truncated: boolean };

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
export const zoomLevel = writable<ZoomLevel>('overview');
export const currentView = writable<string>('overview');
export const currentViewInfo = writable<ViewInfo>({ kind: 'overview', granularity: 1 });
export const currentGraphPayload = writable<CurrentGraphPayload | null>(null);
export const currentDatabaseInfo = writable<DbInfoResponse | null>(null);
export const demoRepos = writable<DemoRepoInfo[]>([]);
export const showLanding = writable<boolean>(false);

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
    target.kind === 'overview'
      ? [`view:${target.kind}`, `branch:${target.branch}`]
      : target.kind === 'galaxy'
      ? [`view:${target.kind}`, `branch:${target.branch}`]
      : target.kind === 'neighborhood'
        ? [`view:${target.kind}`, `branch:${target.branch}`, `symbol:${target.symbolId}`, `depth:${target.depth}`]
        : target.kind === 'blast-radius'
          ? [`view:${target.kind}`, `branch:${target.branch}`, `symbol:${target.symbolId}`]
          : target.kind === 'path'
            ? [`view:${target.kind}`, `branch:${target.branch}`, `from:${target.fromId}`, `to:${target.toId}`]
            : target.kind === 'directory'
              ? [`view:${target.kind}`, `branch:${target.branch}`, `directory:${target.directoryPath}`]
              : [`view:${target.kind}`, `branch:${target.branch}`, `file:${target.filePath}`];

  return stableHash([...head, ...nodes, ...edges]);
}

function overviewGraphContentId(target: GraphLoadTarget, payload: OverviewGraphResponse): string {
  const nodeKeys = payload.nodes
    .map((node) => `${node.id}:${node.directoryPath ?? node.filePath}:${node.symbolCount}:${node.fileCount ?? 0}`)
    .sort();
  const edgeKeys = payload.edges.map((edge) => `${edge.from}:${edge.to}:${edge.callCount}`).sort();
  return createGraphContentId(target, nodeKeys, edgeKeys);
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

function blastRadiusGraphContentId(target: GraphLoadTarget, payload: BlastRadiusResponse): string {
  const nodeKeys = payload.nodes.map((node) => `${node.id}:${node.name}:${node.degree}`).sort();
  const edgeKeys = payload.edges.map((edge) => `${edge.id}:${edge.from}:${edge.to ?? 'null'}:${edge.isResolved}`).sort();
  return createGraphContentId(target, nodeKeys, edgeKeys);
}

function pathGraphContentId(target: GraphLoadTarget, payload: PathResponse): string {
  const nodeKeys = payload.path.map((node) => `${node.id}:${node.name}:${node.filePath}`).sort();
  const edgeKeys = payload.edges.map((edge) => `${edge.id}:${edge.from}:${edge.to ?? 'null'}:${edge.isResolved}`).sort();
  return createGraphContentId(target, nodeKeys, edgeKeys);
}

function directoryGraphContentId(target: GraphLoadTarget, payload: DirectoryGraphResponse): string {
  const nodeKeys = payload.nodes.map((node) => `${node.id}:${node.filePath}:${node.role ?? 'internal'}:${node.symbolCount}`).sort();
  const edgeKeys = payload.edges.map((edge) => `${edge.id}:${edge.from}:${edge.to}:${edge.boundary}:${edge.callCount}`).sort();
  return createGraphContentId(target, nodeKeys, edgeKeys);
}

function fileGraphContentId(target: GraphLoadTarget, payload: FileGraphResponse): string {
  const nodeKeys = payload.nodes.map((node) => `${node.id}:${node.name}:${node.role ?? 'internal'}:${node.degree}`).sort();
  const edgeKeys = payload.edges.map((edge) => `${edge.id}:${edge.from}:${edge.to ?? 'null'}:${edge.boundary ?? 'internal'}:${edge.isResolved}`).sort();
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
  private latestDbInfo: DbInfoResponse | null = null;

  async initialize(initialUrlState: UrlState = {}): Promise<void> {
    this.lastUrlState = initialUrlState;
    this.branchesAbortController?.abort();
    const branchesAbortController = new AbortController();
    this.branchesAbortController = branchesAbortController;

    graphLoading.set(true);
    graphError.set(null);

    try {
      const dbInfo = await fetchDbInfo(branchesAbortController.signal);
      if (branchesAbortController.signal.aborted) {
        return;
      }

      this.latestDbInfo = dbInfo;
      currentDatabaseInfo.set(dbInfo);
      showLanding.set(!dbInfo.available);
      if (!dbInfo.available) {
        graphInstance.set(null);
        focusedSymbolId.set(null);
        graphNodeCount.set(0);
        graphEdgeCount.set(0);
        graphTruncated.set(false);
        currentGraphPayload.set(null);
        currentViewInfo.set({ kind: 'overview', granularity: 1 });
        currentView.set('overview');
        const demos = await fetchDemoRepos(branchesAbortController.signal);
        if (!branchesAbortController.signal.aborted) {
          demoRepos.set(demos);
          availableBranches.set([]);
          activeBranch.set('');
          graphLoading.set(false);
        }
        this.initialized = true;
        return;
      }

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
      demoRepos.set(await fetchDemoRepos(branchesAbortController.signal).catch(() => []));
      this.initialized = true;

      if (initialUrlState.view === 'blast' && initialUrlState.symbolId) {
        await this.loadBlastRadius(initialUrlState.symbolId, branch);
      } else if (initialUrlState.view === 'path' && initialUrlState.fromId && initialUrlState.toId) {
        await this.loadPath(initialUrlState.fromId, initialUrlState.toId, branch);
      } else if (initialUrlState.view === 'directory' && initialUrlState.directoryPath) {
        await this.loadDirectory(initialUrlState.directoryPath, branch);
      } else if (initialUrlState.view === 'file' && initialUrlState.filePath) {
        await this.loadFile(initialUrlState.filePath, branch);
      } else if (initialUrlState.view === 'galaxy') {
        await this.loadGalaxy(branch);
      } else if (initialUrlState.symbolId) {
        await this.loadNeighborhood(initialUrlState.symbolId, { branch, depth });
      } else {
        await this.loadOverview(branch);
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

  async loadOverview(branch = get(activeBranch)): Promise<void> {
    if (!branch) {
      graphError.set('No active branch selected');
      return;
    }

    const target: GraphLoadTarget = { kind: 'overview', branch };
    this.currentTarget = target;
    this.lastUrlState = { branch, view: 'overview' };

    const load = this.beginGraphLoad();

    try {
      const payload = await fetchOverviewGraph(branch, load.abortController.signal);
      if (!this.isActiveGraphLoad(load.revision, load.abortController.signal)) {
        return;
      }

      const contentId = overviewGraphContentId(target, payload);
      const graph = buildOverviewGraphologyInstance(payload, contentId);
      const layoutCacheHit = restoreLayoutSnapshot(graph, contentId);
      this.commitGraphLoad({
        graph,
        target,
        contentId,
        layoutCacheHit,
        nodeCount: payload.nodes.length,
        edgeCount: payload.edges.length,
        truncated: false,
        payload: { kind: 'overview', payload },
        viewInfo: { kind: 'overview', granularity: payload.granularity },
      });
    } catch (error) {
      this.handleGraphLoadError(error, load.revision);
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
        payload: { kind: 'galaxy', payload },
        viewInfo: { kind: 'galaxy' },
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
        payload: { kind: 'neighborhood', payload },
        viewInfo: {
          kind: 'atom',
          mode: 'symbol',
          symbolId,
          symbolName: payload.nodes.find((node) => node.id === symbolId)?.name ?? symbolId,
          filePath: payload.nodes.find((node) => node.id === symbolId)?.filePath,
        },
      });
    } catch (error) {
      this.handleGraphLoadError(error, load.revision);
    }
  }

  async loadBlastRadius(symbolId: string, branch = get(activeBranch)): Promise<void> {
    if (!symbolId || !branch) {
      graphError.set('Cannot load blast radius without a symbol and branch');
      return;
    }

    const target: GraphLoadTarget = {
      kind: 'blast-radius',
      branch,
      symbolId,
    };

    this.currentTarget = target;
    this.lastUrlState = {
      branch,
      symbolId,
      view: 'blast',
    };

    const load = this.beginGraphLoad();

    try {
      const payload = await fetchBlastRadius(symbolId, branch, load.abortController.signal);
      if (!this.isActiveGraphLoad(load.revision, load.abortController.signal)) {
        return;
      }

      const contentId = blastRadiusGraphContentId(target, payload);
      const graph = buildBlastRadiusGraphologyInstance(payload, contentId);
      const layoutCacheHit = restoreLayoutSnapshot(graph, contentId);
      this.commitGraphLoad({
        graph,
        target,
        contentId,
        layoutCacheHit,
        nodeCount: payload.nodes.length,
        edgeCount: payload.edges.length,
        truncated: payload.truncated,
        payload: { kind: 'blast-radius', payload },
        viewInfo: {
          kind: 'blast',
          symbolId,
          symbolName: payload.nodes.find((node) => node.id === symbolId)?.name ?? symbolId,
          truncated: payload.truncated,
        },
      });
    } catch (error) {
      this.handleGraphLoadError(error, load.revision);
    }
  }

  async loadPath(fromId: string, toId: string, branch = get(activeBranch)): Promise<void> {
    if (!fromId || !toId || !branch) {
      graphError.set('Cannot load a path without a source, target, and branch');
      return;
    }

    const target: GraphLoadTarget = {
      kind: 'path',
      branch,
      fromId,
      toId,
    };

    this.currentTarget = target;
    this.lastUrlState = {
      branch,
      symbolId: fromId,
      fromId,
      toId,
      view: 'path',
    };

    const load = this.beginGraphLoad();

    try {
      const payload = await fetchPath(fromId, toId, branch, load.abortController.signal);
      if (!this.isActiveGraphLoad(load.revision, load.abortController.signal)) {
        return;
      }

      const contentId = pathGraphContentId(target, payload);
      const graph = buildPathGraphologyInstance(payload.path, payload.edges, contentId);
      const layoutCacheHit = restoreLayoutSnapshot(graph, contentId);
      this.commitGraphLoad({
        graph,
        target,
        contentId,
        layoutCacheHit,
        nodeCount: payload.path.length,
        edgeCount: payload.edges.length,
        truncated: false,
        payload: { kind: 'path', payload },
        viewInfo: {
          kind: 'path',
          fromId,
          toId,
          fromName: payload.path[0]?.name ?? fromId,
          toName: payload.path[payload.path.length - 1]?.name ?? toId,
          hopCount: Math.max(payload.path.length - 1, 0),
          found: payload.found,
          exhausted: payload.exhausted,
        },
      });
    } catch (error) {
      this.handleGraphLoadError(error, load.revision);
    }
  }

  async loadDirectory(directoryPath: string, branch = get(activeBranch)): Promise<void> {
    if (!directoryPath || !branch) {
      graphError.set('Cannot load a directory view without a directory and branch');
      return;
    }

    const target: GraphLoadTarget = {
      kind: 'directory',
      branch,
      directoryPath,
    };

    this.currentTarget = target;
    this.lastUrlState = {
      branch,
      directoryPath,
      view: 'directory',
    };

    const load = this.beginGraphLoad();

    try {
      const payload = await fetchDirectoryGraph(directoryPath, branch, load.abortController.signal);
      if (!this.isActiveGraphLoad(load.revision, load.abortController.signal)) {
        return;
      }

      const contentId = directoryGraphContentId(target, payload);
      const graph = buildDirectoryGraphologyInstance(payload, contentId);
      const layoutCacheHit = restoreLayoutSnapshot(graph, contentId);
      this.commitGraphLoad({
        graph,
        target,
        contentId,
        layoutCacheHit,
        nodeCount: payload.nodes.length,
        edgeCount: payload.edges.length,
        truncated: payload.truncated,
        payload: { kind: 'directory', payload },
        viewInfo: {
          kind: 'directory',
          directoryPath,
          truncated: payload.truncated,
        },
      });
    } catch (error) {
      this.handleGraphLoadError(error, load.revision);
    }
  }

  async loadFile(filePath: string, branch = get(activeBranch)): Promise<void> {
    if (!filePath || !branch) {
      graphError.set('Cannot load a file view without a file path and branch');
      return;
    }

    const target: GraphLoadTarget = {
      kind: 'file',
      branch,
      filePath,
    };

    this.currentTarget = target;
    this.lastUrlState = {
      branch,
      filePath,
      view: 'file',
    };

    const load = this.beginGraphLoad();

    try {
      const payload = await fetchFileGraph(filePath, branch, load.abortController.signal);
      if (!this.isActiveGraphLoad(load.revision, load.abortController.signal)) {
        return;
      }

      const contentId = fileGraphContentId(target, payload);
      const graph = buildFileGraphologyInstance(payload, contentId);
      const layoutCacheHit = restoreLayoutSnapshot(graph, contentId);
      this.commitGraphLoad({
        graph,
        target,
        contentId,
        layoutCacheHit,
        nodeCount: payload.nodes.length,
        edgeCount: payload.edges.length,
        truncated: payload.truncated,
        payload: { kind: 'file', payload },
        viewInfo: {
          kind: 'atom',
          mode: 'file',
          filePath,
          directoryPath: filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || '.',
        },
      });
    } catch (error) {
      this.handleGraphLoadError(error, load.revision);
    }
  }

  async selectDemo(demoId: string): Promise<void> {
    graphLoading.set(true);
    graphError.set(null);
    try {
      const dbInfo = await selectDemoDatabase(demoId);
      this.latestDbInfo = dbInfo;
      currentDatabaseInfo.set(dbInfo);
      availableBranches.set(dbInfo.branches);
      activeBranch.set(dbInfo.branch ?? '');
      showLanding.set(false);
      this.initialized = true;
      await this.loadOverview(dbInfo.branch ?? '');
    } catch (error) {
      graphError.set(error instanceof Error ? error.message : 'Failed to load demo database.');
      graphLoading.set(false);
    }
  }

  async uploadDb(file: File): Promise<void> {
    graphLoading.set(true);
    graphError.set(null);
    try {
      const dbInfo = await uploadDatabase(file);
      this.latestDbInfo = dbInfo;
      currentDatabaseInfo.set(dbInfo);
      availableBranches.set(dbInfo.branches);
      activeBranch.set(dbInfo.branch ?? '');
      showLanding.set(false);
      this.initialized = true;
      await this.loadOverview(dbInfo.branch ?? '');
    } catch (error) {
      graphError.set(error instanceof Error ? error.message : "This file doesn't look like a HyperBase index. Make sure to select a `.opencode/index/codebase.db` file.");
      graphLoading.set(false);
    }
  }

  async changeBranch(branch: string): Promise<void> {
    activeBranch.set(branch);
    if (!this.initialized) {
      return;
    }

    if (this.currentTarget?.kind === 'overview') {
      await this.loadOverview(branch);
      return;
    }

    if (this.currentTarget?.kind === 'neighborhood') {
      await this.loadNeighborhood(this.currentTarget.symbolId, {
        branch,
        depth: get(graphDepth),
      });
      return;
    }

    if (this.currentTarget?.kind === 'blast-radius') {
      await this.loadBlastRadius(this.currentTarget.symbolId, branch);
      return;
    }

    if (this.currentTarget?.kind === 'path') {
      await this.loadPath(this.currentTarget.fromId, this.currentTarget.toId, branch);
      return;
    }

    if (this.currentTarget?.kind === 'directory') {
      await this.loadDirectory(this.currentTarget.directoryPath, branch);
      return;
    }

    if (this.currentTarget?.kind === 'file') {
      await this.loadFile(this.currentTarget.filePath, branch);
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

    if (this.currentTarget?.kind === 'overview') {
      await this.loadOverview(this.currentTarget.branch);
      return;
    }

    if (this.currentTarget?.kind === 'blast-radius') {
      await this.loadBlastRadius(this.currentTarget.symbolId, this.currentTarget.branch);
      return;
    }

    if (this.currentTarget?.kind === 'path') {
      await this.loadPath(this.currentTarget.fromId, this.currentTarget.toId, this.currentTarget.branch);
      return;
    }

    if (this.currentTarget?.kind === 'directory') {
      await this.loadDirectory(this.currentTarget.directoryPath, this.currentTarget.branch);
      return;
    }

    if (this.currentTarget?.kind === 'file') {
      await this.loadFile(this.currentTarget.filePath, this.currentTarget.branch);
      return;
    }

    const branch = get(activeBranch);
    if (branch) {
      await this.loadOverview(branch);
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
    viewInfo: ViewInfo;
    payload: CurrentGraphPayload;
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
    currentGraphPayload.set(options.payload);
    currentViewInfo.set(options.viewInfo);
    currentView.set(
      options.target.kind === 'overview'
        ? 'overview'
        : options.target.kind === 'galaxy'
        ? 'galaxy'
        : options.target.kind === 'neighborhood'
          ? 'atom'
          : options.target.kind === 'file'
            ? 'atom'
          : options.target.kind === 'blast-radius'
            ? 'blast'
            : options.target.kind === 'path'
              ? 'path'
              : 'directory'
    );
    focusedSymbolId.set(
      options.target.kind === 'neighborhood' || options.target.kind === 'blast-radius'
        ? options.target.symbolId
        : options.target.kind === 'path'
          ? options.target.fromId
          : null
    );
    graphLoading.set(false);
    showLanding.set(false);
    if (this.latestDbInfo) {
      currentDatabaseInfo.set({
        ...this.latestDbInfo,
        available: true,
        branch: options.target.branch,
      });
    }

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
export const loadOverviewGraph = (branch?: string) => graphController.loadOverview(branch);
export const loadGalaxyGraph = (branch?: string) => graphController.loadGalaxy(branch);
export const loadNeighborhoodGraph = (symbolId: string, options?: { branch?: string; depth?: number }) =>
  graphController.loadNeighborhood(symbolId, options);
export const loadBlastRadiusGraph = (symbolId: string, branch?: string) => graphController.loadBlastRadius(symbolId, branch);
export const loadPathGraph = (fromId: string, toId: string, branch?: string) => graphController.loadPath(fromId, toId, branch);
export const loadDirectoryGraph = (directoryPath: string, branch?: string) => graphController.loadDirectory(directoryPath, branch);
export const loadFileGraph = (filePath: string, branch?: string) => graphController.loadFile(filePath, branch);
export const changeActiveBranch = (branch: string) => graphController.changeBranch(branch);
export const changeGraphDepth = (depth: number) => graphController.changeDepth(depth);
export const retryGraphLoad = () => graphController.retry();
export const setGraphOverlay = (overlay: Overlay) => graphController.setOverlay(overlay);
export const selectDemoGraph = (demoId: string) => graphController.selectDemo(demoId);
export const uploadDatabaseGraph = (file: File) => graphController.uploadDb(file);
