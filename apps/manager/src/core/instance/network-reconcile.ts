/** 启动时恢复 Manager 到历史实例网络；单实例故障不能阻塞控制台启动。 */
export type NetworkReconcileResult =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reconcileOne(
  id: string,
  reconnect: (instanceId: string, signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): Promise<NetworkReconcileResult> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let complete = false;
    const finish = (result: NetworkReconcileResult) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      controller.abort(new Error(`${timeoutMs}ms 内未完成网络恢复`));
      finish({ id, ok: false, error: `${timeoutMs}ms 内未完成网络恢复` });
    }, timeoutMs);

    Promise.resolve().then(() => reconnect(id, controller.signal)).then(
      () => finish({ id, ok: true }),
      (error: unknown) => finish({ id, ok: false, error: errorText(error) }),
    );
  });
}

/** 并发恢复，且每个实例都有边界；返回结果供调用方逐项清晰告警。 */
export async function reconcileInstanceNetworks(
  ids: readonly string[],
  reconnect: (instanceId: string, signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): Promise<NetworkReconcileResult[]> {
  return Promise.all(ids.map((id) => reconcileOne(id, reconnect, timeoutMs)));
}
