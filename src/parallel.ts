// How many downloads, uploads or checks run at once. Enough to stop waiting on one slow request
// at a time, and well inside what Discord, Microsoft and Google allow.
export const PARALLEL = 4;

// Runs `work` for every item, at most `limit` at a time, and returns the results in the order of
// the items. After a failure no new work starts, and what is already running finishes before the
// error is thrown, so nothing is still in flight when the caller stops.
export async function mapParallel<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  limit = PARALLEL,
): Promise<R[]> {
  const results: R[] = [];
  let failed = false;
  // The workers share one iterator, so each item is taken exactly once.
  const queue = items.entries();
  const worker = async () => {
    for (const [index, item] of queue) {
      if (failed) return;
      try {
        results[index] = await work(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  const workers = await Promise.allSettled(Array.from({ length: limit }, worker));
  for (const outcome of workers) {
    if (outcome.status === 'rejected') throw outcome.reason;
  }
  return results;
}
