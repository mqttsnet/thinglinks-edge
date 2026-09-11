/** A page-local request slot: quiet polls share work; explicit scope changes can replace it. */
export function createFieldRefreshTask() {
  let generation = 0;
  let disposed = false;
  let pending: Promise<void> | undefined;
  return {
    run(task: (current: () => boolean) => Promise<void>, replace = false): Promise<void> {
      if (disposed) return Promise.resolve();
      if (pending && !replace) return pending;
      const ticket = ++generation;
      const current = () => !disposed && ticket === generation;
      const request = (async () => { await task(current); })().finally(() => {
        if (pending === request) pending = undefined;
      });
      pending = request;
      return request;
    },
    dispose() {
      disposed = true;
      ++generation;
    },
  };
}
