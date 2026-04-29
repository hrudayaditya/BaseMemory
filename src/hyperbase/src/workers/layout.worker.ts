import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import forceAtlas2, { inferSettings } from 'graphology-layout-forceatlas2';
import type { SerializedGraph } from 'graphology-types';
import { LAYOUT_POST_EPSILON, LAYOUT_WORKER_BATCH } from '../lib/constants';

type StartMessage = {
  type: 'start';
  graph: SerializedGraph;
  iterations: number;
};

type StopMessage = {
  type: 'stop';
};

type CommunityMessage = {
  type: 'communities';
  graph: SerializedGraph;
};

type WorkerMessage = StartMessage | StopMessage | CommunityMessage;
type PositionMap = Record<string, { x: number; y: number }>;

function positionsFor(graph: Graph): PositionMap {
  const positions: Record<string, { x: number; y: number }> = {};
  graph.forEachNode((node, attributes) => {
    positions[node] = { x: attributes.x, y: attributes.y };
  });
  return positions;
}

function deltaPositionsFor(
  graph: Graph,
  previous: PositionMap,
  epsilon: number
): PositionMap {
  const positions: PositionMap = {};
  graph.forEachNode((node, attributes) => {
    const last = previous[node];
    if (
      !last ||
      Math.abs(attributes.x - last.x) > epsilon ||
      Math.abs(attributes.y - last.y) > epsilon
    ) {
      positions[node] = { x: attributes.x, y: attributes.y };
    }
  });
  return positions;
}

function projectBoundaryNodes(graph: Graph): void {
  let maxRadius = 0;
  graph.forEachNode((_node, attributes) => {
    const radius = Math.hypot(attributes.x, attributes.y);
    maxRadius = Math.max(maxRadius, radius);
  });

  const boundaryRadius = Math.max(maxRadius * 1.08, 360);

  graph.forEachNode((node, attributes) => {
    const role = (attributes.layoutRole ?? attributes.role) as string | undefined;
    if (!role || role === 'internal') {
      return;
    }

    const seed = `${node}:${role}`;
    let hash = 2166136261;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const unit = (hash >>> 0) / 0xffffffff;

    const angle =
      role === 'external-caller'
        ? Math.PI * (0.7 + unit * 0.6)
        : role === 'external-callee'
          ? Math.PI * (-0.3 + unit * 0.6)
          : Math.PI * (1.35 + unit * 0.3);

    graph.mergeNodeAttributes(node, {
      x: Math.cos(angle) * boundaryRadius,
      y: Math.sin(angle) * boundaryRadius,
    });
  });
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const payload = event.data;
  if (payload.type === 'communities') {
    const graph = new Graph();
    graph.import(payload.graph);
    const communities = louvain(graph);
    self.postMessage({
      type: 'communities',
      communities,
    });
    return;
  }

  if (payload.type !== 'start') {
    return;
  }

  const graph = new Graph();
  graph.import(payload.graph);

  const settings = inferSettings(graph);
  let completed = 0;
  let stopped = false;
  let previousPositions: PositionMap = {};

  const stopHandler = (stopEvent: MessageEvent<WorkerMessage>) => {
    if (stopEvent.data.type === 'stop') {
      stopped = true;
    }
  };

  self.addEventListener('message', stopHandler as EventListener);

  while (completed < payload.iterations && !stopped) {
    const batch = Math.min(LAYOUT_WORKER_BATCH, payload.iterations - completed);
    forceAtlas2.assign(graph, { iterations: batch, settings });
    completed += batch;

    const positions = previousPositions && completed < payload.iterations
      ? deltaPositionsFor(graph, previousPositions, LAYOUT_POST_EPSILON)
      : positionsFor(graph);
    previousPositions = positionsFor(graph);

    self.postMessage({
      type: 'progress',
      positions,
      iteration: completed,
    });
  }

  self.removeEventListener('message', stopHandler as EventListener);

  if (stopped) {
    return;
  }

  projectBoundaryNodes(graph);

  self.postMessage({
    type: 'done',
    positions: positionsFor(graph),
  });
};
