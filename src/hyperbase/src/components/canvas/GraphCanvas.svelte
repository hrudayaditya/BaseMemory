<script lang="ts">
  import type Graph from 'graphology';
  import { onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import Sigma from 'sigma';
  import ContextMenu from '../overlays/ContextMenu.svelte';
  import {
    activeOverlay,
    cinematicFocusRequest,
    clearCinematicFocus,
    focusMode,
    focusedNodeIds,
    pathFindingHint,
    pathFindingMode,
    pathFindingSource,
    sidebarOpen,
  } from '../../stores/ui';
  import {
    activeBranch,
    cameraState,
    currentView,
    focusedSymbolId,
    graphContentId,
    graphInstance,
    graphLayoutRunning,
    graphRefreshNonce,
    graphSettledNodeIds,
    loadDirectoryGraph,
    loadFileGraph,
    loadPathGraph,
    sigmaInstance,
    zoomLevel,
  } from '../../stores/graph';
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
  let sigma: Sigma<any, any, any> | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let currentGraph: HyperGraph | null = null;
  let currentSelectedNodeId: string | null = null;
  let currentHoveredNodeId: string | null = null;
  let currentContentId: string | null = null;
  let currentOverlay: Overlay = 'none';
  let currentOverlayMetrics: OverlayMetrics = EMPTY_OVERLAY_METRICS;
  let currentGraphView = 'overview';
  let currentPathFindingMode = false;
  let currentPathFindingSource: string | null = null;
  let currentFocusMode = false;
  let currentFocusedNodeIds = new Set<string>();
  let currentLayoutRunning = false;
  let currentSettledNodeIds = new Set<string>();
  let currentCinematicFocus: { nodeId: string; reason: 'search'; ratio?: number } | null = null;
  let cameraCleanup: (() => void) | null = null;
  let draggedNodeId: string | null = null;
  let dragStartViewport: { x: number; y: number } | null = null;
  let suppressNextNodeClick = false;
  let dragCameraPanningEnabled = true;
  let currentAnnotations: Record<string, AnnotationEntry> = {};
  let annotationBadges: Array<{ nodeId: string; x: number; y: number }> = [];
  let pulseMarker: { nodeId: string; x: number; y: number } | null = null;
  let blastGlowMarker: { nodeId: string; x: number; y: number } | null = null;
  let currentPulseNodeId: string | null = null;
  let pulseTimeout: ReturnType<typeof setTimeout> | null = null;
  let blastRevealTimers: Array<ReturnType<typeof setTimeout>> = [];
  let currentBlastRevealDepth = Number.POSITIVE_INFINITY;
  let currentBlastCenterNodeId: string | null = null;
  let blastAnimationContentId: string | null = null;
  let contextMenuOpen = false;
  let contextMenuX = 0;
  let contextMenuY = 0;
  let contextMenuNodeId: string | null = null;
  let renderSnapshot: RenderSnapshot = {
    activeNodeId: null,
    selectionNodeId: null,
    connectedNodeIds: new Set<string>(),
    connectedEdgeIds: new Set<string>(),
    overlay: 'none',
    focusMode: false,
    focusedNodeIds: new Set<string>(),
    degreeMax: 1,
    deadNodeIds: new Set<string>(),
    hotspotNodeIds: new Set<string>(),
    edgeCallCountMax: 1,
    layoutRunning: false,
    settledNodeIds: new Set<string>(),
    blastRevealDepth: Number.POSITIVE_INFINITY,
    pulseNodeId: null,
  };
  let selectedConnectedNodeIds = new Set<string>();
  let selectedConnectedEdgeIds = new Set<string>();

  type EntityType = 'directory' | 'file' | 'symbol';

  function nodeEntityType(nodeId: string): EntityType | null {
    if (!currentGraph?.hasNode(nodeId)) {
      return null;
    }
    const attributes = currentGraph.getNodeAttributes(nodeId) as { entityType?: EntityType };
    return attributes.entityType ?? null;
  }

  function recomputeOverlayMetrics() {
    currentOverlayMetrics = computeOverlayMetrics(currentGraph, currentOverlay);
  }

  function recomputeAnnotationBadges() {
    if (!sigma || !currentGraph || !canvasShell) {
      annotationBadges = [];
      return;
    }

    const renderer = sigma;
    const graph = currentGraph;

    const { width, height } = canvasShell.getBoundingClientRect();
    const nextBadges: Array<{ nodeId: string; x: number; y: number }> = [];

    Object.keys(currentAnnotations).forEach((nodeId) => {
      if (!graph.hasNode(nodeId)) {
        return;
      }

      const displayData = renderer.getNodeDisplayData(nodeId);
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

  function recomputeHeroMarkers() {
    if (!sigma || !currentGraph) {
      pulseMarker = null;
      blastGlowMarker = null;
      return;
    }

    pulseMarker = null;
    if (currentPulseNodeId && currentGraph.hasNode(currentPulseNodeId)) {
      const displayData = sigma.getNodeDisplayData(currentPulseNodeId);
      if (displayData) {
        pulseMarker = {
          nodeId: currentPulseNodeId,
          x: displayData.x,
          y: displayData.y,
        };
      }
    }

    blastGlowMarker = null;
    if (currentGraphView === 'blast' && currentBlastCenterNodeId && currentGraph.hasNode(currentBlastCenterNodeId)) {
      const displayData = sigma.getNodeDisplayData(currentBlastCenterNodeId);
      if (displayData) {
        blastGlowMarker = {
          nodeId: currentBlastCenterNodeId,
          x: displayData.x,
          y: displayData.y,
        };
      }
    }
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

  function recomputeSelectedAdjacency() {
    const connectedNodeIds = new Set<string>();
    const connectedEdgeIds = new Set<string>();

    if (currentGraph && currentSelectedNodeId && currentGraph.hasNode(currentSelectedNodeId)) {
      connectedNodeIds.add(currentSelectedNodeId);
      currentGraph.forEachNeighbor(currentSelectedNodeId, (neighbor) => {
        connectedNodeIds.add(neighbor);
      });
      currentGraph.forEachEdge(currentSelectedNodeId, (edge) => {
        connectedEdgeIds.add(edge);
      });
    }

    selectedConnectedNodeIds = connectedNodeIds;
    selectedConnectedEdgeIds = connectedEdgeIds;
  }

  function recomputeRenderSnapshot() {
    const activeNodeId = currentHoveredNodeId ?? currentSelectedNodeId;

    renderSnapshot = {
      activeNodeId,
      selectionNodeId: currentSelectedNodeId,
      connectedNodeIds: selectedConnectedNodeIds,
      connectedEdgeIds: selectedConnectedEdgeIds,
      overlay: currentOverlay,
      focusMode: currentFocusMode,
      focusedNodeIds: currentFocusedNodeIds,
      degreeMax: currentOverlayMetrics.degreeMax,
      deadNodeIds: currentOverlayMetrics.deadNodeIds,
      hotspotNodeIds: currentOverlayMetrics.hotspotNodeIds,
      edgeCallCountMax: currentOverlayMetrics.edgeCallCountMax,
      layoutRunning: currentLayoutRunning,
      settledNodeIds: currentSettledNodeIds,
      blastRevealDepth: currentBlastRevealDepth,
      pulseNodeId: currentPulseNodeId,
    };

    sigma?.refresh();
  }

  function clearBlastRevealAnimation() {
    blastRevealTimers.forEach((timer) => clearTimeout(timer));
    blastRevealTimers = [];
    currentBlastRevealDepth = Number.POSITIVE_INFINITY;
  }

  function resolveBlastCenterNodeId(): string | null {
    if (!currentGraph || currentGraphView !== 'blast') {
      return null;
    }

    let centerNodeId: string | null = null;
    currentGraph.forEachNode((node, attributes) => {
      if (typeof (attributes as { depth?: unknown }).depth === 'number' && (attributes as { depth: number }).depth === 0) {
        centerNodeId = node;
      }
    });
    return centerNodeId;
  }

  function startBlastRevealAnimation() {
    clearBlastRevealAnimation();
    currentBlastCenterNodeId = resolveBlastCenterNodeId();

    if (currentGraphView !== 'blast' || !currentGraph) {
      currentBlastRevealDepth = Number.POSITIVE_INFINITY;
      recomputeHeroMarkers();
      recomputeRenderSnapshot();
      return;
    }

    currentBlastRevealDepth = 0;
    const sequence = [
      { depth: 1, delay: 180 },
      { depth: 2, delay: 470 },
      { depth: 3, delay: 820 },
      { depth: Number.POSITIVE_INFINITY, delay: 1100 },
    ];

    blastRevealTimers = sequence.map(({ depth, delay }) =>
      setTimeout(() => {
        currentBlastRevealDepth = depth;
        recomputeRenderSnapshot();
      }, delay)
    );

    recomputeHeroMarkers();
    recomputeRenderSnapshot();
  }

  function triggerNodePulse(nodeId: string) {
    if (pulseTimeout) {
      clearTimeout(pulseTimeout);
      pulseTimeout = null;
    }

    currentPulseNodeId = nodeId;
    recomputeHeroMarkers();
    recomputeRenderSnapshot();

    pulseTimeout = setTimeout(() => {
      currentPulseNodeId = null;
      recomputeHeroMarkers();
      recomputeRenderSnapshot();
    }, 760);
  }

  function maybeRunCinematicFocus() {
    if (!sigma || !currentGraph || !currentCinematicFocus || currentLayoutRunning) {
      return;
    }

    const { nodeId, ratio } = currentCinematicFocus;
    if (!currentGraph.hasNode(nodeId)) {
      return;
    }

    const displayData = sigma.getNodeDisplayData(nodeId);
    if (!displayData) {
      return;
    }

    currentCinematicFocus = null;
    clearCinematicFocus();

    sigma.getCamera().animate(
      {
        x: displayData.x,
        y: displayData.y,
        ratio: Math.max(Math.min(ratio ?? 0.72, 1.15), 0.46),
      },
      { duration: 620 },
      () => {
        triggerNodePulse(nodeId);
      }
    );
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
        recomputeHeroMarkers();
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
      recomputeSelectedAdjacency();
      currentBlastCenterNodeId = resolveBlastCenterNodeId();

      if (!container || !graph) {
        currentBlastCenterNodeId = null;
        recomputeRenderSnapshot();
        recomputeAnnotationBadges();
        recomputeHeroMarkers();
        return;
      }

      if (!sigma) {
        sigma = new Sigma(graph, container, buildSigmaSettings(() => renderSnapshot));
        sigmaInstance.set(sigma);
        const renderer = sigma;

        renderer.on('clickNode', ({ node }) => {
          if (suppressNextNodeClick) {
            suppressNextNodeClick = false;
            return;
          }

          const entityType = nodeEntityType(node);
          const sourceNodeId = currentPathFindingSource ?? get(selectedNodeId) ?? get(focusedSymbolId);

          if (currentPathFindingMode && sourceNodeId && entityType === 'symbol' && node !== sourceNodeId) {
            pathFindingHint.set(null);
            cancelPathFinding();
            void loadPathGraph(sourceNodeId, node);
            return;
          }

          sidebarOpen.set(true);
          const nextNodeData = currentGraph?.hasNode(node)
            ? (currentGraph.getNodeAttributes(node) as unknown as Record<string, unknown>)
            : null;
          void selectNode(node, nextNodeData);
          closeContextMenu();
        });

        renderer.on('downNode', ({ node, event }) => {
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

        renderer.on('moveBody', ({ event }) => {
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

        renderer.on('upNode', () => {
          endDrag();
        });

        renderer.on('upStage', () => {
          endDrag();
        });

        renderer.on('enterNode', ({ node }) => {
          hoveredNodeId.set(node);
          if (
            currentPathFindingMode &&
            currentPathFindingSource &&
            node !== currentPathFindingSource &&
            currentGraph?.hasNode(node) &&
            nodeEntityType(node) === 'symbol'
          ) {
            const attributes = currentGraph.getNodeAttributes(node) as { name?: string; label?: string };
            pathFindingHint.set(`Click to find path to ${attributes.name ?? attributes.label ?? node}`);
          }
        });

        renderer.on('leaveNode', () => {
          hoveredNodeId.set(null);
          if (currentPathFindingMode) {
            pathFindingHint.set(null);
          }
        });

        renderer.on('doubleClickNode', ({ node, event }) => {
          if (!sigma || !currentGraph) {
            return;
          }

          const attributes = currentGraph.getNodeAttributes(node) as FileGraphNodeAttributes;
          const displayData = sigma.getNodeDisplayData(node);
          const entityType = attributes.entityType;
          if (!displayData) {
            return;
          }

          const canOpenModule = currentGraphView === 'overview' && entityType === 'directory' && attributes.directoryPath;
          const canOpenFile = currentGraphView === 'directory' && entityType === 'file' && attributes.filePath;
          if (!canOpenModule && !canOpenFile) {
            return;
          }

          event.preventSigmaDefault();
          const camera = renderer.getCamera();
          const nextRatio = Math.max(camera.ratio * 0.48, 0.18);
          camera.animate(
            { x: displayData.x, y: displayData.y, ratio: nextRatio },
            { duration: 240 },
            () => {
              if (canOpenModule && attributes.directoryPath) {
                void loadDirectoryGraph(attributes.directoryPath, get(activeBranch));
              } else if (canOpenFile && attributes.filePath) {
                void loadFileGraph(attributes.filePath, get(activeBranch));
              }
            }
          );
        });

        renderer.on('rightClickNode', ({ node, event }) => {
          if (!currentGraph?.hasNode(node)) {
            return;
          }

          event.preventSigmaDefault();
          event.original.preventDefault();
          const nextNodeData = currentGraph.getNodeAttributes(node) as unknown as Record<string, unknown>;
          void selectNode(node, nextNodeData);
          openContextMenu(node, event.x, event.y);
        });

        renderer.on('clickStage', () => {
          closeContextMenu();
        });

        renderer.on('rightClickStage', ({ event }) => {
          event.preventSigmaDefault();
          event.original.preventDefault();
          closeContextMenu();
        });

        renderer.on('afterRender', () => {
          recomputeAnnotationBadges();
          recomputeHeroMarkers();
          maybeRunCinematicFocus();
        });

        bindCamera();
      } else {
        sigma.setGraph(graph);
        bindCamera();
      }

      if (currentGraphView === 'blast' && currentContentId && blastAnimationContentId !== currentContentId) {
        blastAnimationContentId = currentContentId;
        startBlastRevealAnimation();
      } else if (currentGraphView !== 'blast') {
        blastAnimationContentId = null;
        currentBlastCenterNodeId = null;
        clearBlastRevealAnimation();
      }

      recomputeRenderSnapshot();
      recomputeAnnotationBadges();
      recomputeHeroMarkers();
      maybeRunCinematicFocus();
    });

    const selectedUnsubscribe = selectedNodeId.subscribe((value) => {
      currentSelectedNodeId = value;
      recomputeSelectedAdjacency();
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
      if (value === 'blast') {
        if (currentContentId) {
          blastAnimationContentId = currentContentId;
        }
        startBlastRevealAnimation();
      } else {
        blastAnimationContentId = null;
        currentBlastCenterNodeId = null;
        clearBlastRevealAnimation();
        recomputeHeroMarkers();
        recomputeRenderSnapshot();
      }
    });

    const refreshUnsubscribe = graphRefreshNonce.subscribe(() => {
      sigma?.refresh();
      recomputeAnnotationBadges();
    });

    const annotationsUnsubscribe = annotations.subscribe((value) => {
      currentAnnotations = value;
      recomputeAnnotationBadges();
    });

    const layoutRunningUnsubscribe = graphLayoutRunning.subscribe((value) => {
      currentLayoutRunning = value;
      recomputeRenderSnapshot();
      maybeRunCinematicFocus();
    });

    const settledNodeIdsUnsubscribe = graphSettledNodeIds.subscribe((value) => {
      currentSettledNodeIds = value;
      recomputeRenderSnapshot();
    });

    const cinematicFocusUnsubscribe = cinematicFocusRequest.subscribe((value) => {
      currentCinematicFocus = value;
      maybeRunCinematicFocus();
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
      cinematicFocusUnsubscribe();
      settledNodeIdsUnsubscribe();
      layoutRunningUnsubscribe();
      overlayUnsubscribe();
      hoveredUnsubscribe();
      selectedUnsubscribe();
      graphUnsubscribe();
    };
  });

  onDestroy(() => {
    if (pulseTimeout) {
      clearTimeout(pulseTimeout);
    }
    clearBlastRevealAnimation();
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
    {#if blastGlowMarker}
      <div class="blast-glow" style={`left:${blastGlowMarker.x}px; top:${blastGlowMarker.y}px;`}></div>
    {/if}

    {#if pulseMarker}
      <div class="pulse-ring" style={`left:${pulseMarker.x}px; top:${pulseMarker.y}px;`}></div>
    {/if}

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

  .pulse-ring,
  .blast-glow {
    position: absolute;
    transform: translate(-50%, -50%);
    border-radius: 999px;
  }

  .pulse-ring {
    width: 26px;
    height: 26px;
    border: 2px solid color-mix(in srgb, var(--text-accent) 72%, transparent);
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--text-accent) 18%, transparent);
    animation: node-pulse 720ms ease-out forwards;
  }

  .blast-glow {
    width: 54px;
    height: 54px;
    background: radial-gradient(circle, color-mix(in srgb, var(--analytics-blast-depth-1) 48%, transparent) 0%, transparent 70%);
    filter: blur(2px);
    animation: blast-glow 1.8s ease-in-out infinite;
  }

  @keyframes node-pulse {
    0% {
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.8);
    }

    20% {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }

    100% {
      opacity: 0;
      transform: translate(-50%, -50%) scale(1.85);
    }
  }

  @keyframes blast-glow {
    0%,
    100% {
      opacity: 0.45;
      transform: translate(-50%, -50%) scale(0.92);
    }

    50% {
      opacity: 0.85;
      transform: translate(-50%, -50%) scale(1.08);
    }
  }
</style>
