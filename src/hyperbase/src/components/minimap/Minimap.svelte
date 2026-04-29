<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { cameraState, graphInstance, sigmaInstance } from '../../stores/graph';

  let canvas: HTMLCanvasElement;
  let graph: ReturnType<typeof $graphInstance> | null = null;
  let camera = { x: 0.5, y: 0.5, ratio: 1, angle: 0 };

  function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#161b22';
    ctx.fillRect(0, 0, width, height);

    if (!graph || graph.order === 0) {
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    graph.forEachNode((_node, attributes) => {
      minX = Math.min(minX, attributes.x);
      maxX = Math.max(maxX, attributes.x);
      minY = Math.min(minY, attributes.y);
      maxY = Math.max(maxY, attributes.y);
    });

    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);

    const toCanvas = (x: number, y: number) => ({
      x: ((x - minX) / spanX) * width,
      y: ((y - minY) / spanY) * height,
    });

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    graph.forEachEdge((_edge, attributes, source, target) => {
      const sourcePos = graph?.getNodeAttributes(source);
      const targetPos = graph?.getNodeAttributes(target);
      if (!sourcePos || !targetPos) return;
      const a = toCanvas(sourcePos.x, sourcePos.y);
      const b = toCanvas(targetPos.x, targetPos.y);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });

    graph.forEachNode((_node, attributes) => {
      const point = toCanvas(attributes.x, attributes.y);
      ctx.fillStyle = attributes.color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
      ctx.fill();
    });

    const viewportWidth = Math.max(width * 0.22 / camera.ratio, 18);
    const viewportHeight = Math.max(height * 0.22 / camera.ratio, 12);
    const centerX = width * camera.x;
    const centerY = height * camera.y;

    ctx.fillStyle = 'rgba(79,156,249,0.12)';
    ctx.strokeStyle = 'rgba(79,156,249,0.8)';
    ctx.lineWidth = 1;
    ctx.fillRect(centerX - viewportWidth / 2, centerY - viewportHeight / 2, viewportWidth, viewportHeight);
    ctx.strokeRect(centerX - viewportWidth / 2, centerY - viewportHeight / 2, viewportWidth, viewportHeight);
  }

  function handleClick(event: MouseEvent) {
    const sigma = $sigmaInstance;
    if (!sigma || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    sigma.getCamera().animate({ x, y }, { duration: 250 });
  }

  const graphUnsubscribe = graphInstance.subscribe((value) => {
    graph = value;
    draw();
  });

  const cameraUnsubscribe = cameraState.subscribe((value) => {
    camera = value;
    draw();
  });

  onMount(() => {
    draw();
  });

  onDestroy(() => {
    graphUnsubscribe();
    cameraUnsubscribe();
  });
</script>

<canvas bind:this={canvas} width="180" height="120" class="minimap" on:click={handleClick}></canvas>

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
