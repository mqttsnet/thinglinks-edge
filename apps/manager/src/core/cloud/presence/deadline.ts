/** Pass cancellation to the transport as well as fencing late promise settlement. */
export async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs: number): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('状态查询已取消'));
  parent.addEventListener('abort', cancel, { once: true });
  if (parent.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs);
  try {
    return await new Promise<T>((resolve, reject) => {
      const fail = () => reject(new Error('状态查询已取消或超时'));
      if (abort.signal.aborted) { fail(); return; }
      abort.signal.addEventListener('abort', fail, { once: true });
      operation(abort.signal).then(resolve, reject).finally(() => abort.signal.removeEventListener('abort', fail));
    });
  } finally {
    clearTimeout(timer); parent.removeEventListener('abort', cancel);
  }
}
