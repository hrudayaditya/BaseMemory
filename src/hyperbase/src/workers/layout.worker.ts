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

  self.postMessage({
    type: 'done',
    positions: previousPositions,
  });
};
