<script lang="ts">
  import type Graph from 'graphology';
  import { onDestroy, onMount } from 'svelte';
  import Sigma from 'sigma';
  import { sidebarOpen, activeOverlay } from '../../stores/ui';
  import {
    cameraState,
    graphInstance,
    graphRefreshNonce,
    sigmaInstance,
    zoomLevel,
  } from '../../stores/graph';
  import { hoveredNodeId, selectedNodeId, selectNode } from '../../stores/selection';
  import { buildSigmaSettings, type RenderSnapshot } from '../../lib/sigma-config';
  import { ZOOM_ATOM_THRESHOLD, ZOOM_GALAXY_THRESHOLD } from '../../lib/constants';
  import type { FileGraphNodeAttributes, GraphEdgeAttributes, SymbolGraphNodeAttributes } from '../../types';

  type HyperGraph = Graph<FileGraphNodeAttributes | SymbolGraphNodeAttributes, GraphEdgeAttributes>;

  let container: HTMLDivElement;
  let sigma: Sigma | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let currentGraph: HyperGraph | null = null;
  let currentSelectedNodeId: string | null = null;
  let currentHoveredNodeId: string | null = null;
  let currentOverlay = 'none';
  let cameraCleanup: (() => void) | null = null;
  let renderSnapshot: RenderSnapshot = {
    activeNodeId: null,
    connectedNodeIds: new Set<string>(),
    connectedEdgeIds: new Set<string>(),
    overlay: 'none',
  };

  function recomputeRenderSnapshot() {
    const activeNodeId = currentHoveredNodeId ?? currentSelectedNodeId;
    const connectedNodeIds = new Set<string>();
    const connectedEdgeIds = new Set<string>();

    if (currentGraph && activeNodeId && currentGraph.hasNode(activeNodeId)) {
      connectedNodeIds.add(activeNodeId);
      currentGraph.forEachNeighbor(activeNodeId, (neighbor) => {
        connectedNodeIds.add(neighbor);
      });
      currentGraph.forEachEdge(activeNodeId, (edge) => {
        connectedEdgeIds.add(edge);
      });
    }

    renderSnapshot = {
      activeNodeId,
      connectedNodeIds,
      connectedEdgeIds,
      overlay: currentOverlay,
    };

    sigma?.refresh();
  }

  function updateZoomLevel() {
    if (!sigma) return;
    const ratio = sigma.getCamera().ratio;
    if (ratio <= ZOOM_GALAXY_THRESHOLD) {
      zoomLevel.set('galaxy');
    } else if (ratio >= ZOOM_ATOM_THRESHOLD) {
      zoomLevel.set('atom');
    } else {
      zoomLevel.set('solar');
    }
  }

  function bindCamera() {
    cameraCleanup?.();
    if (!sigma) return;

    const camera = sigma.getCamera();
    const handleUpdated = () => {
      const state = camera.getState();
      cameraState.set(state);
      updateZoomLevel();
    };

    camera.on('updated', handleUpdated);
    handleUpdated();
    cameraCleanup = () => camera.off('updated', handleUpdated);
  }

  onMount(() => {
    const graphUnsubscribe = graphInstance.subscribe((graph) => {
      currentGraph = graph;

      if (!container || !graph) {
        return;
      }

      if (!sigma) {
        sigma = new Sigma(graph, container, buildSigmaSettings(() => renderSnapshot));
        sigmaInstance.set(sigma);

        sigma.on('clickNode', ({ node }) => {
          sidebarOpen.set(true);
          const nextNodeData = currentGraph?.hasNode(node)
            ? (currentGraph.getNodeAttributes(node) as Record<string, unknown>)
            : null;
          void selectNode(node, nextNodeData);
        });

        sigma.on('enterNode', ({ node }) => {
          hoveredNodeId.set(node);
        });

        sigma.on('leaveNode', () => {
          hoveredNodeId.set(null);
        });

        bindCamera();
      } else {
        sigma.setGraph(graph);
        bindCamera();
      }

      recomputeRenderSnapshot();
    });

    const selectedUnsubscribe = selectedNodeId.subscribe((value) => {
      currentSelectedNodeId = value;
      recomputeRenderSnapshot();
    });

    const hoveredUnsubscribe = hoveredNodeId.subscribe((value) => {
      currentHoveredNodeId = value;
      recomputeRenderSnapshot();
    });

    const overlayUnsubscribe = activeOverlay.subscribe((value) => {
      currentOverlay = value;
      recomputeRenderSnapshot();
    });

    const refreshUnsubscribe = graphRefreshNonce.subscribe(() => {
      sigma?.refresh();
    });

    resizeObserver = new ResizeObserver(() => {
      sigma?.resize();
      sigma?.refresh();
    });
    resizeObserver.observe(container);

    return () => {
      refreshUnsubscribe();
      overlayUnsubscribe();
      hoveredUnsubscribe();
      selectedUnsubscribe();
      graphUnsubscribe();
    };
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    cameraCleanup?.();
    sigma?.kill();
    sigmaInstance.set(null);
  });
</script>

<div bind:this={container} class="graph-canvas"></div>

<style>
  .graph-canvas {
    width: 100%;
    height: 100%;
    position: absolute;
    inset: 0;
    z-index: var(--z-canvas);
  }
</style>
