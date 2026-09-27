/**
 * A sample dragged out of the sample browser. It travels in the drag's own
 * data under a type of the app's, so a Track lane or a Pad knows it from
 * anything else dragged over it.
 */
import type { SampleRef } from "./sample-source";

export const SAMPLE_DRAG_TYPE = "application/x-soundcheck-sample";

export function startSampleDrag(transfer: DataTransfer, sample: SampleRef): void {
  transfer.setData(SAMPLE_DRAG_TYPE, JSON.stringify(sample));
  transfer.effectAllowed = "copy";
}

/** Whether a drag carries a sample. Its data can only be read on the drop itself. */
export function isSampleDrag(transfer: DataTransfer): boolean {
  return [...transfer.types].includes(SAMPLE_DRAG_TYPE);
}

/** The sample a drop carries, or null if it carries none. */
export function droppedSample(transfer: DataTransfer): SampleRef | null {
  const text = transfer.getData(SAMPLE_DRAG_TYPE);
  if (!text) return null;
  try {
    const { folder, path } = JSON.parse(text) as Partial<SampleRef>;
    if (typeof folder?.id !== "string" || typeof folder.label !== "string" || typeof path !== "string") return null;
    return { folder: { id: folder.id, label: folder.label }, path };
  } catch {
    return null;
  }
}
