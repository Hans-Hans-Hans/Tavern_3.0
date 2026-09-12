// Complete a synthetic navigation drag at its intended target position.
export async function navigationDrop(target, dataTransfer, { before = false } = {}) {
  await target.scrollIntoViewIfNeeded();
  await target.evaluate((element, { transfer, before }) => {
    const bounds = element.getBoundingClientRect();
    if (!element.isConnected || !bounds.width || !bounds.height) throw new Error('The navigation drop target is unavailable.');
    const init = { bubbles: true, cancelable: true, dataTransfer: transfer,
      clientX: bounds.x + bounds.width / 2, clientY: bounds.y + (before ? 2 : bounds.height / 2) };
    // Auto-scroll can move the row between the earlier hover assertion and the
    // drop. Reposition the synthetic pointer and drop in the same browser task,
    // so another animation frame cannot turn an intended before into an after.
    element.dispatchEvent(new DragEvent('dragover', init));
    element.dispatchEvent(new DragEvent('drop', init));
  }, { transfer: dataTransfer, before });
}
