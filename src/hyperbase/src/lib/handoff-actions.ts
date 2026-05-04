import { get } from 'svelte/store';
import { graphInstance, currentGraphPayload, currentViewInfo } from '../stores/graph';
import { selectedNodeId } from '../stores/selection';
import { focusedNodeIds, openHandoffModal } from '../stores/ui';
import { deriveHandoffSelection, generateHandoffReport } from './handoff-report';

export function openGeneratedHandoff(selectionOverride?: Iterable<string>): void {
  const graph = get(graphInstance);
  const payload = get(currentGraphPayload);
  const viewInfo = get(currentViewInfo);

  if (!graph || !payload) {
    return;
  }

  const selection = selectionOverride
    ? Array.from(selectionOverride)
    : deriveHandoffSelection(graph, payload, viewInfo, get(selectedNodeId), get(focusedNodeIds));

  if (selection.length === 0) {
    return;
  }

  const report = generateHandoffReport(selection, graph, payload, viewInfo);
  openHandoffModal(report.title, report.markdown);
}
