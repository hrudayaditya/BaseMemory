<script lang="ts">
  import type Graph from 'graphology';
  import { onDestroy, onMount } from 'svelte';
  import { getTheme } from '../../lib/theme';
  import { cameraState, graphInstance, sigmaInstance } from '../../stores/graph';
  import type Sigma from 'sigma';
  import type { FileGraphNodeAttributes, GraphEdgeAttributes, SymbolGraphNodeAttributes } from '../../types';

  const MINIMAP_WIDTH = 180;
  const MINIMAP_HEIGHT = 120;
  const MINIMAP_CAMERA = { x: 0.5, y: 0.5, ratio: 1, angle: 0 };

  let canvas: HTMLCanvasElement;
  let graph: Graph<FileGraphNodeAttributes | SymbolGraphNodeAttributes, GraphEdgeAttributes> | null = null;
  let sigma: Sigma<any, any, any> | null = null;

  function minimapOverride(renderer: Sigma) {
    return {
      cameraState: MINIMAP_CAMERA,
      viewportDimensions: { width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT },
      graphDimensions: renderer.getGraphDimensions(),
      padding: 0,
    };
  }

  function scaleFromSigmaViewport(renderer: Sigma, point: { x: number; y: number }) {
    const dimensions = renderer.getDimensions();
    return {
      x: (point.x / dimensions.width) * MINIMAP_WIDTH,
      y: (point.y / dimensions.height) * MINIMAP_HEIGHT,
    };
  }

  function scaleToSigmaViewport(renderer: Sigma, point: { x: number; y: number }) {
    const dimensions = renderer.getDimensions();
    return {
      x: (point.x / MINIMAP_WIDTH) * dimensions.width,
      y: (point.y / MINIMAP_HEIGHT) * dimensions.height,
    };
  }

  function graphToMinimap(renderer: Sigma, point: { x: number; y: number }) {
    const projected = renderer.graphToViewport(point, minimapOverride(renderer));
    return scaleFromSigmaViewport(renderer, projected);
  }

  function framedToMinimap(renderer: Sigma, point: { x: number; y: number }) {
    const projected = renderer.framedGraphToViewport(point, minimapOverride(renderer));
    return scaleFromSigmaViewport(renderer, projected);
  }

  function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const theme = getTheme();

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = theme.minimap.background;
    ctx.fillRect(0, 0, width, height);

    if (!graph || graph.order === 0 || !sigma) {
      return;
    }

    const currentGraph = graph;
    const renderer = sigma;

    ctx.strokeStyle = theme.minimap.edge;
    ctx.lineWidth = 1;
    currentGraph.forEachEdge((_edge: string, _attributes: GraphEdgeAttributes, source: string, target: string) => {
      const sourcePos = currentGraph.getNodeAttributes(source);
      const targetPos = currentGraph.getNodeAttributes(target);
      if (!sourcePos || !targetPos) return;
      const a = graphToMinimap(renderer, sourcePos);
      const b = graphToMinimap(renderer, targetPos);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });

    currentGraph.forEachNode((_node: string, attributes: FileGraphNodeAttributes | SymbolGraphNodeAttributes) => {
      const point = graphToMinimap(renderer, attributes);
      ctx.fillStyle = attributes.color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
      ctx.fill();
    });

    const stageDimensions = renderer.getDimensions();
    const viewportCorners = [
      renderer.viewportToFramedGraph({ x: 0, y: 0 }),
      renderer.viewportToFramedGraph({ x: stageDimensions.width, y: 0 }),
      renderer.viewportToFramedGraph({ x: stageDimensions.width, y: stageDimensions.height }),
      renderer.viewportToFramedGraph({ x: 0, y: stageDimensions.height }),
    ].map((point) => framedToMinimap(renderer, point));

    ctx.fillStyle = theme.minimap.viewportFill;
    ctx.strokeStyle = theme.minimap.viewportStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(viewportCorners[0].x, viewportCorners[0].y);
    for (let index = 1; index < viewportCorners.length; index += 1) {
      ctx.lineTo(viewportCorners[index].x, viewportCorners[index].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function handleClick(event: MouseEvent) {
    if (!sigma || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const minimapPoint = {
      x: ((event.clientX - rect.left) / rect.width) * MINIMAP_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * MINIMAP_HEIGHT,
    };
    const sigmaViewportPoint = scaleToSigmaViewport(sigma, minimapPoint);
    const framedPoint = sigma.viewportToFramedGraph(sigmaViewportPoint, minimapOverride(sigma));
    sigma.getCamera().animate({ x: framedPoint.x, y: framedPoint.y }, { duration: 250 });
  }

  const graphUnsubscribe = graphInstance.subscribe((value) => {
    graph = value;
    draw();
  });

  const cameraUnsubscribe = cameraState.subscribe((value) => {
    void value;
    draw();
  });

  const sigmaUnsubscribe = sigmaInstance.subscribe((value) => {
    sigma = value;
    draw();
  });

  onMount(() => {
    draw();
  });

  onDestroy(() => {
    graphUnsubscribe();
    cameraUnsubscribe();
    sigmaUnsubscribe();
  });
</script>

<canvas bind:this={canvas} width={MINIMAP_WIDTH} height={MINIMAP_HEIGHT} class="minimap" on:click={handleClick}></canvas>

<style>
  .minimap {
    position: fixed;
    right: var(--space-lg);
    bottom: var(--space-lg);
    width: 180px;
    height: 120px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    z-index: var(--z-minimap);
    overflow: hidden;
  }
</style>
