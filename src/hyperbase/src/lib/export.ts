import type Graph from 'graphology';
import type Sigma from 'sigma';
import { getTheme } from './theme';
import type {
  CurrentGraphPayload,
  FileGraphNodeAttributes,
  GraphEdgeAttributes,
  SymbolGraphNodeAttributes,
} from '../types';

type HyperGraph = Graph<FileGraphNodeAttributes | SymbolGraphNodeAttributes, GraphEdgeAttributes>;

function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadTextFile(content: string, filename: string, mimeType = 'text/plain;charset=utf-8'): void {
  downloadBlob(new Blob([content], { type: mimeType }), filename);
}

export async function exportCanvasPng(sigma: Sigma, filename = 'hyperbase-view.png'): Promise<void> {
  const { width, height } = sigma.getDimensions();
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const context = output.getContext('2d');
  if (!context) {
    throw new Error('Could not initialize a 2D canvas for PNG export');
  }

  const canvases = sigma.getCanvases();
  Object.values(canvases).forEach((canvas) => {
    context.drawImage(canvas, 0, 0, width, height);
  });

  const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
  if (!blob) {
    throw new Error('Could not encode PNG export');
  }

  downloadBlob(blob, filename);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function exportVisibleGraphSvg(
  sigma: Sigma,
  graph: HyperGraph,
  filename = 'hyperbase-view.svg'
): void {
  const theme = getTheme();
  const { width, height } = sigma.getDimensions();

  const visibleNodes = graph
    .nodes()
    .map((nodeId) => {
      const attrs = graph.getNodeAttributes(nodeId);
      const viewport = sigma.graphToViewport({ x: attrs.x, y: attrs.y });
      return {
        nodeId,
        attrs,
        viewport,
      };
    })
    .filter(({ viewport }) => viewport.x >= -60 && viewport.x <= width + 60 && viewport.y >= -60 && viewport.y <= height + 60);

  const visibleNodeIds = new Set(visibleNodes.map((node) => node.nodeId));

  const edgeMarkup = graph
    .edges()
    .map((edgeId) => {
      const [source, target] = graph.extremities(edgeId);
      if (!visibleNodeIds.has(source) || !visibleNodeIds.has(target)) {
        return null;
      }

      const sourceAttrs = graph.getNodeAttributes(source);
      const targetAttrs = graph.getNodeAttributes(target);
      const sourcePoint = sigma.graphToViewport({ x: sourceAttrs.x, y: sourceAttrs.y });
      const targetPoint = sigma.graphToViewport({ x: targetAttrs.x, y: targetAttrs.y });
      const edgeAttrs = graph.getEdgeAttributes(edgeId);

      return `<line x1="${sourcePoint.x}" y1="${sourcePoint.y}" x2="${targetPoint.x}" y2="${targetPoint.y}" stroke="${escapeXml(
        String(edgeAttrs.color)
      )}" stroke-width="${Math.max(Number(edgeAttrs.size) || 1, 1)}" stroke-linecap="round" opacity="0.95" />`;
    })
    .filter(Boolean)
    .join('\n');

  const nodeMarkup = visibleNodes
    .map(({ attrs, viewport }) => {
      const label = escapeXml(String(attrs.label ?? attrs.name ?? ''));
      return [
        `<circle cx="${viewport.x}" cy="${viewport.y}" r="${Math.max(Number(attrs.size) || 4, 3)}" fill="${escapeXml(String(
          attrs.color
        ))}" />`,
        label
          ? `<text x="${viewport.x + 10}" y="${viewport.y + 4}" fill="${escapeXml(theme.text.primary)}" font-family="Inter, system-ui, sans-serif" font-size="11">${label}</text>`
          : '',
      ].join('\n');
    })
    .join('\n');

  const markup = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${escapeXml(theme.background.primary)}" />
  <g>${edgeMarkup}</g>
  <g>${nodeMarkup}</g>
</svg>`;

  downloadTextFile(markup, filename, 'image/svg+xml;charset=utf-8');
}

export function exportGraphJson(payload: CurrentGraphPayload, filename = 'hyperbase-view.json'): void {
  downloadTextFile(JSON.stringify(payload.payload, null, 2), filename, 'application/json;charset=utf-8');
}
