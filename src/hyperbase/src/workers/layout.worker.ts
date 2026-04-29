import Graph from 'graphology';
import forceAtlas2, { inferSettings } from 'graphology-layout-forceatlas2';
import type { SerializedGraph } from 'graphology-types';
import { LAYOUT_WORKER_BATCH } from '../lib/constants';

type StartMessage = {
  type: 'start';
  graph: SerializedGraph;
  iterations: number;
};

type StopMessage = {
  type: 'stop';
};

type WorkerMessage = StartMessage | StopMessage;

function positionsFor(graph: Graph): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  graph.forEachNode((node, attributes) => {
    positions[node] = { x: attributes.x, y: attributes.y };
  });
  return positions;
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const payload = event.data;
  if (payload.type !== 'start') {
    return;
  }

  const graph = new Graph();
  graph.import(payload.graph);

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
