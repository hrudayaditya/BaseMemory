import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import forceAtlas2, { inferSettings } from 'graphology-layout-forceatlas2';
import type { SerializedGraph } from 'graphology-types';
import { LAYOUT_WORKER_BATCH } from '../lib/constants';

type StartMessage = {
  type: 'start';
  graph: SerializedGraph;
  iterations: number;
  seed?: string | null;
};

type StopMessage = {
  type: 'stop';
};

type CommunityMessage = {
  type: 'communities';
  graph: SerializedGraph;
};

type WorkerMessage = StartMessage | StopMessage | CommunityMessage;

function seededUnit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function seedGraphPositions(graph: Graph, seed: string | null | undefined): void {
  if (!seed) {
    return;
  }

  graph.forEachNode((node) => {
    const x = seededUnit(`${seed}:${node}:x`) * 1000 - 500;
    const y = seededUnit(`${seed}:${node}:y`) * 1000 - 500;
    graph.mergeNodeAttributes(node, { x, y });
  });
}

function positionsFor(graph: Graph): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  graph.forEachNode((node, attributes) => {
    positions[node] = { x: attributes.x, y: attributes.y };
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
  seedGraphPositions(graph, payload.seed);

  const settings = inferSettings(graph);
  let completed = 0;

  while (completed < payload.iterations) {
    const batch = Math.min(LAYOUT_WORKER_BATCH, payload.iterations - completed);
    forceAtlas2.assign(graph, { iterations: batch, settings });
    completed += batch;

    self.postMessage({
      type: 'progress',
      positions: positionsFor(graph),
      iteration: completed,
    });
  }

  self.postMessage({
    type: 'done',
    positions: positionsFor(graph),
  });
};
