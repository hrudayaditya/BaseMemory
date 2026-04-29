<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Sigma from 'sigma';
  import louvain from 'graphology-communities-louvain';
  import { activeOverlay, sidebarOpen } from '../../stores/ui';
  import {
    cameraState,
    graphInstance,
    sigmaInstance,
    zoomLevel,
  } from '../../stores/graph';
  import { hoveredNodeId, selectedNodeData, selectedNodeId } from '../../stores/selection';
  import { buildSigmaSettings } from '../../lib/sigma-config';
  import { stringToHue } from '../../lib/graph-utils';
  import { ZOOM_ATOM_THRESHOLD, ZOOM_GALAXY_THRESHOLD } from '../../lib/constants';

  let container: HTMLDivElement;
  let sigma: Sigma | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let currentGraph: ReturnType<typeof $graphInstance> | null = null;
  let currentSelectedNodeId: string | null = null;
  let currentHoveredNodeId: string | null = null;
  let currentOverlay: string = 'none';
  let cameraCleanup: (() => void) | null = null;

  function applyOverlay() {
    if (!currentGraph) return;

    if (currentOverlay === 'community') {
      const communities = louvain(currentGraph);
      currentGraph.forEachNode((node, attributes) => {
        const community = communities[node];
        const hue = stringToHue(String(community));
        currentGraph?.mergeNodeAttributes(node, {
          community,
          communityColor: `hsl(${hue}, 78%, 62%)`,
          color: attributes.color,
        });
      });
    } else {
      currentGraph.forEachNode((node) => {
        currentGraph?.mergeNodeAttributes(node, { communityColor: undefined, community: undefined });
      });
    }
  }

  function applyHighlightState() {
    if (!currentGraph || !sigma) return;

    const activeNode = currentHoveredNodeId ?? currentSelectedNodeId;
    const connectedNodes = new Set<string>();
    const connectedEdges = new Set<string>();

    if (activeNode && currentGraph.hasNode(activeNode)) {
      connectedNodes.add(activeNode);
      currentGraph.forEachNeighbor(activeNode, (neighbor) => {
        connectedNodes.add(neighbor);
      });
      currentGraph.forEachEdge(activeNode, (edge) => {
        connectedEdges.add(edge);
      });
    }

    currentGraph.forEachNode((node) => {
      currentGraph?.mergeNodeAttributes(node, {
        highlighted: activeNode !== null && node === activeNode,
        dimmed: activeNode !== null && !connectedNodes.has(node),
      });
    });

    currentGraph.forEachEdge((edge) => {
      currentGraph?.mergeEdgeAttributes(edge, {
        highlighted: activeNode !== null && connectedEdges.has(edge),
      });
    });

    sigma.refresh();
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

      if (!container || !graph) return;

      applyOverlay();

      if (!sigma) {
        sigma = new Sigma(graph, container, buildSigmaSettings());
        sigmaInstance.set(sigma);

        sigma.on('clickNode', ({ node }) => {
          selectedNodeId.set(node);
          selectedNodeData.set(graph.getNodeAttributes(node));
          sidebarOpen.set(true);
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
        sigma.refresh();
      }

      applyHighlightState();
    });

    const selectedUnsubscribe = selectedNodeId.subscribe((value) => {
      currentSelectedNodeId = value;
      if (currentGraph && value && currentGraph.hasNode(value)) {
        selectedNodeData.set(currentGraph.getNodeAttributes(value));
      }
      applyHighlightState();
    });

    const hoveredUnsubscribe = hoveredNodeId.subscribe((value) => {
      currentHoveredNodeId = value;
      applyHighlightState();
    });

    const overlayUnsubscribe = activeOverlay.subscribe((value) => {
      currentOverlay = value;
      applyOverlay();
      applyHighlightState();
    });

    resizeObserver = new ResizeObserver(() => {
      sigma?.resize();
      sigma?.refresh();
    });
    resizeObserver.observe(container);

    return () => {
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
