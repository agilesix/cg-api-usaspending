/**
 * Spaces out request starts, so a refresh stays under an upstream API's rate
 * limit however many requests are in flight. USAspending stops answering
 * entirely (empty replies, for several minutes) when a client sends a few
 * dozen requests a second.
 */
export function createPacer(intervalMs: number): () => Promise<void> {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + intervalMs;
    if (at > now) await new Promise(resolve => setTimeout(resolve, at - now));
  };
}
