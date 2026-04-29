<script lang="ts">
  import type Graph from 'graphology';
  import { onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import Sigma from 'sigma';
  import ContextMenu from '../overlays/ContextMenu.svelte';
  import { activeOverlay, focusMode, focusedNodeIds, pathFindingHint, pathFindingMode, pathFindingSource, sidebarOpen } from '../../stores/ui';
  import { activeBranch, cameraState, currentView, focusedSymbolId, graphContentId, graphInstance, graphRefreshNonce, loadDirectoryGraph, loadPathGraph, sigmaInstance, zoomLevel } from '../../stores/graph';
  import { hoveredNodeId, selectedNodeId, selectNode } from '../../stores/selection';
  import { buildSigmaSettings, type RenderSnapshot } from '../../lib/sigma-config';
  import { DRAG_CLICK_SUPPRESSION_DISTANCE, ZOOM_ATOM_THRESHOLD, ZOOM_GALAXY_THRESHOLD } from '../../lib/constants';
  import { captureLayoutSnapshot, persistLayoutSnapshot } from '../../lib/layout-cache';
  import { computeOverlayMetrics, EMPTY_OVERLAY_METRICS, type OverlayMetrics } from '../../lib/overlays';
  import { cancelPathFinding } from '../../stores/ui';
  import { annotations, getAnnotation, openAnnotationEditor, type AnnotationEntry } from '../../lib/annotations';
  import type { FileGraphNodeAttributes, GraphEdgeAttributes, Overlay, SymbolGraphNodeAttributes } from '../../types';

  type HyperGraph = Graph<FileGraphNodeAttributes | SymbolGraphNodeAttributes, GraphEdgeAttributes>;

  let container: HTMLDivElement;
  let canvasShell: HTMLDivElement;
  let sigma: Sigma | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let currentGraph: HyperGraph | null = null;
  let currentSelectedNodeId: string | null = null;
  let currentHoveredNodeId: string | null = null;
  let currentContentId: string | null = null;
  let currentOverlay: Overlay = 'none';
  let currentOverlayMetrics: OverlayMetrics = EMPTY_OVERLAY_METRICS;
  let currentGraphView = 'galaxy';
  let currentPathFindingMode = false;
  let currentPathFindingSource: string | null = null;
  let currentFocusMode = false;
  let currentFocusedNodeIds = new Set<string>();
  let cameraCleanup: (() => void) | null = null;
  let draggedNodeId: string | null = null;
  let dragStartViewport: { x: number; y: number } | null = null;
  let suppressNextNodeClick = false;
  let dragCameraPanningEnabled = true;
  let currentAnnotations: Record<string, AnnotationEntry> = {};
  let annotationBadges: Array<{ nodeId: string; x: number; y: number }> = [];
  let contextMenuOpen = false;
  let contextMenuX = 0;
  let contextMenuY = 0;
  let contextMenuNodeId: string | null = null;
  let renderSnapshot: RenderSnapshot = {
    activeNodeId: null,
    connectedNodeIds: new Set<string>(),
    connectedEdgeIds: new Set<string>(),
    overlay: 'none',
    focusMode: false,
    focusedNodeIds: new Set<string>(),
    degreeMax: 1,
    deadNodeIds: new Set<string>(),
    hotspotNodeIds: new Set<string>(),
    edgeCallCountMax: 1,
  };

  function recomputeOverlayMetrics() {
    currentOverlayMetrics = computeOverlayMetrics(currentGraph, currentOverlay);
  }

  function recomputeAnnotationBadges() {
    if (!sigma || !currentGraph || !canvasShell) {
      annotationBadges = [];
      return;
    }

    const { width, height } = canvasShell.getBoundingClientRect();
    const nextBadges: Array<{ nodeId: string; x: number; y: number }> = [];

    Object.keys(currentAnnotations).forEach((nodeId) => {
      if (!currentGraph.hasNode(nodeId)) {
        return;
      }

      const displayData = sigma.getNodeDisplayData(nodeId);
      if (!displayData) {
        return;
      }

      const x = displayData.x + displayData.size * 0.7;
      const y = displayData.y - displayData.size * 0.7;
      if (x < -24 || y < -24 || x > width + 24 || y > height + 24) {
        return;
      }

      nextBadges.push({ nodeId, x, y });
    });

    annotationBadges = nextBadges;
  }

  function closeContextMenu() {
    contextMenuOpen = false;
    contextMenuNodeId = null;
  }

  function openContextMenu(nodeId: string, x: number, y: number) {
    contextMenuNodeId = nodeId;
    contextMenuX = x;
    contextMenuY = y;
    contextMenuOpen = true;
  }

  function editContextNodeAnnotation() {
    if (!contextMenuNodeId) {
      return;
    }
    openAnnotationEditor(contextMenuNodeId, getAnnotation(contextMenuNodeId)?.note ?? '');
    closeContextMenu();
  }

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
      focusMode: currentFocusMode,
      focusedNodeIds: currentFocusedNodeIds,
      degreeMax: currentOverlayMetrics.degreeMax,
      deadNodeIds: currentOverlayMetrics.deadNodeIds,
      hotspotNodeIds: currentOverlayMetrics.hotspotNodeIds,
      edgeCallCountMax: currentOverlayMetrics.edgeCallCountMax,
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
        recomputeAnnotationBadges();
      };

    camera.on('updated', handleUpdated);
    handleUpdated();
    cameraCleanup = () => camera.off('updated', handleUpdated);
  }

  function endDrag() {
    if (!draggedNodeId) {
      return;
    }

    if (sigma) {
      sigma.getCamera().enabledPanning = dragCameraPanningEnabled;
    }

    draggedNodeId = null;
    dragStartViewport = null;

    if (currentGraph && currentContentId) {
      persistLayoutSnapshot(currentContentId, captureLayoutSnapshot(currentGraph));
    }
  }

  onMount(() => {
    const graphUnsubscribe = graphInstance.subscribe((graph) => {
      currentGraph = graph;
      recomputeOverlayMetrics();

      if (!container || !graph) {
        return;
      }

      if (!sigma) {
        sigma = new Sigma(graph, container, buildSigmaSettings(() => renderSnapshot));
        sigmaInstance.set(sigma);

        sigma.on('clickNode', ({ node }) => {
          if (suppressNextNodeClick) {
            suppressNextNodeClick = false;
            return;
          }

          const sourceNodeId = currentPathFindingSource ?? get(selectedNodeId) ?? get(focusedSymbolId);

          if (currentPathFindingMode && sourceNodeId && node !== sourceNodeId) {
            pathFindingHint.set(null);
            cancelPathFinding();
            void loadPathGraph(sourceNodeId, node);
            return;
          }

          sidebarOpen.set(true);
          const nextNodeData = currentGraph?.hasNode(node)
            ? (currentGraph.getNodeAttributes(node) as Record<string, unknown>)
            : null;
          void selectNode(node, nextNodeData);
          closeContextMenu();
        });

        sigma.on('downNode', ({ node, event }) => {
          if (!currentGraph || !sigma || !currentGraph.hasNode(node)) {
            return;
          }

          event.preventSigmaDefault();
          draggedNodeId = node;
          dragStartViewport = { x: event.x, y: event.y };
          suppressNextNodeClick = false;

          const camera = sigma.getCamera();
          dragCameraPanningEnabled = camera.enabledPanning;
          camera.enabledPanning = false;
        });

        sigma.on('moveBody', ({ event }) => {
          if (!sigma || !currentGraph || !draggedNodeId || !currentGraph.hasNode(draggedNodeId)) {
            return;
          }

          event.preventSigmaDefault();
          const graphPosition = sigma.viewportToGraph({ x: event.x, y: event.y });
          currentGraph.mergeNodeAttributes(draggedNodeId, graphPosition);

          if (dragStartViewport) {
            const deltaX = event.x - dragStartViewport.x;
            const deltaY = event.y - dragStartViewport.y;
            if (Math.hypot(deltaX, deltaY) >= DRAG_CLICK_SUPPRESSION_DISTANCE) {
              suppressNextNodeClick = true;
            }
          }

          sigma.refresh();
        });

        sigma.on('upNode', () => {
          endDrag();
        });

        sigma.on('upStage', () => {
          endDrag();
        });

        sigma.on('enterNode', ({ node }) => {
          hoveredNodeId.set(node);
          if (currentPathFindingMode && currentPathFindingSource && node !== currentPathFindingSource && currentGraph?.hasNode(node)) {
            const attributes = currentGraph.getNodeAttributes(node) as { name?: string; label?: string };
            pathFindingHint.set(`Click to find path to ${attributes.name ?? attributes.label ?? node}`);
          }
        });

        sigma.on('leaveNode', () => {
          hoveredNodeId.set(null);
          if (currentPathFindingMode) {
            pathFindingHint.set(null);
          }
        });

        sigma.on('doubleClickNode', ({ node, event }) => {
          if (!sigma || !currentGraph || currentGraphView !== 'galaxy' || !node.startsWith('file::')) {
            return;
          }

          const attributes = currentGraph.getNodeAttributes(node) as FileGraphNodeAttributes;
          const displayData = sigma.getNodeDisplayData(node);
          if (!displayData || !attributes.directory) {
            return;
          }

          event.preventSigmaDefault();
          const camera = sigma.getCamera();
          const nextRatio = Math.max(camera.ratio * 0.48, 0.18);
          camera.animate(
            { x: displayData.x, y: displayData.y, ratio: nextRatio },
            { duration: 240 },
            () => {
              void loadDirectoryGraph(attributes.directory, get(activeBranch));
            }
          );
        });

        sigma.on('rightClickNode', ({ node, event }) => {
          if (!currentGraph?.hasNode(node)) {
            return;
          }

          event.preventSigmaDefault();
          event.original.preventDefault();
          const nextNodeData = currentGraph.getNodeAttributes(node) as Record<string, unknown>;
          void selectNode(node, nextNodeData);
          openContextMenu(node, event.x, event.y);
        });

        sigma.on('clickStage', () => {
          closeContextMenu();
        });

        sigma.on('rightClickStage', ({ event }) => {
          event.preventSigmaDefault();
          event.original.preventDefault();
          closeContextMenu();
        });

        sigma.on('afterRender', () => {
          recomputeAnnotationBadges();
        });

        bindCamera();
      } else {
        sigma.setGraph(graph);
        bindCamera();
      }

      recomputeRenderSnapshot();
      recomputeAnnotationBadges();
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
      recomputeOverlayMetrics();
      recomputeRenderSnapshot();
    });

    const contentUnsubscribe = graphContentId.subscribe((value) => {
      currentContentId = value;
    });

    const pathFindingModeUnsubscribe = pathFindingMode.subscribe((value) => {
      currentPathFindingMode = value;
      if (!value) {
        pathFindingHint.set(null);
      }
    });

    const pathFindingSourceUnsubscribe = pathFindingSource.subscribe((value) => {
      currentPathFindingSource = value;
    });

    const focusModeUnsubscribe = focusMode.subscribe((value) => {
      currentFocusMode = value;
      recomputeRenderSnapshot();
    });

    const focusedNodeIdsUnsubscribe = focusedNodeIds.subscribe((value) => {
      currentFocusedNodeIds = value;
      recomputeRenderSnapshot();
    });

    const currentViewUnsubscribe = currentView.subscribe((value) => {
      currentGraphView = value;
    });

    const refreshUnsubscribe = graphRefreshNonce.subscribe(() => {
      sigma?.refresh();
      recomputeAnnotationBadges();
    });

    const annotationsUnsubscribe = annotations.subscribe((value) => {
      currentAnnotations = value;
      recomputeAnnotationBadges();
    });

    resizeObserver = new ResizeObserver(() => {
      sigma?.resize();
      sigma?.refresh();
      recomputeAnnotationBadges();
    });
      resizeObserver.observe(container);

    return () => {
      annotationsUnsubscribe();
      focusedNodeIdsUnsubscribe();
      focusModeUnsubscribe();
      pathFindingSourceUnsubscribe();
      pathFindingModeUnsubscribe();
      contentUnsubscribe();
      currentViewUnsubscribe();
      refreshUnsubscribe();
      overlayUnsubscribe();
      hoveredUnsubscribe();
      selectedUnsubscribe();
      graphUnsubscribe();
    };
  });

  onDestroy(() => {
    endDrag();
    resizeObserver?.disconnect();
    cameraCleanup?.();
    sigma?.kill();
    sigmaInstance.set(null);
  });
</script>

<div bind:this={canvasShell} class="graph-shell">
  <div bind:this={container} class:path-finding={currentPathFindingMode} class="graph-canvas"></div>

  <div class="annotation-layer" aria-hidden="true">
    {#each annotationBadges as badge (badge.nodeId)}
      <div class="annotation-badge" style={`left:${badge.x}px; top:${badge.y}px;`}></div>
    {/each}
  </div>

  <ContextMenu
    open={contextMenuOpen}
    x={contextMenuX}
    y={contextMenuY}
    noteExists={Boolean(contextMenuNodeId && currentAnnotations[contextMenuNodeId])}
    onAddNote={editContextNodeAnnotation}
    onClose={closeContextMenu}
  />
</div>

<style>
  .graph-shell {
    position: absolute;
    inset: 0;
    z-index: var(--z-canvas);
  }

  .graph-canvas {
    width: 100%;
    height: 100%;
    position: absolute;
    inset: 0;
  }

  .graph-canvas.path-finding {
    cursor: crosshair;
  }

  .annotation-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: calc(var(--z-canvas) + 1);
  }

  .annotation-badge {
    position: absolute;
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--node-constant);
    border: 2px solid var(--bg-primary);
    transform: translate(-50%, -50%);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--node-constant) 35%, transparent);
  }
</style>
