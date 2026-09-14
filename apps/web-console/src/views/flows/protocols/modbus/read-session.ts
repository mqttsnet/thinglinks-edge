import type { ModbusReadConnection, ProtocolDiagnosticTask } from '../../../../api/types.ts';

export interface ModbusReadPort {
  start(instanceId: string, connection: ModbusReadConnection): Promise<ProtocolDiagnosticTask>;
  get(instanceId: string, taskId: string): Promise<ProtocolDiagnosticTask>;
  list(instanceId: string): Promise<ProtocolDiagnosticTask[]>;
  cancel(instanceId: string, taskId: string): Promise<ProtocolDiagnosticTask>;
}
export interface ModbusReadState { task: ProtocolDiagnosticTask | null; pending: boolean; error: string }
export function diagnosticRunning(task: ProtocolDiagnosticTask | null): boolean {
  return Boolean(task && (['preparing', 'connecting', 'reading'].includes(task.state) || task.cleanup === 'pending'));
}
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && 'status' in error ? error.message : fallback;
}

/** Owns only the current view's requests. Closing never starts or repeats a read. */
export function createModbusReadSession(port: ModbusReadPort, changed: (state: ModbusReadState) => void = () => {}) {
  let state: ModbusReadState = { task: null, pending: false, error: '' };
  let instanceId = '', epoch = 0, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined, pollingEpoch: number | undefined;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const current = (ticket: number) => !disposed && epoch === ticket;
  function update(patch: Partial<ModbusReadState>) { state = { ...state, ...patch }; if (!disposed) changed(state); }
  function validate(task: ProtocolDiagnosticTask, instance: string, id?: string) {
    if (!task || task.instanceId !== instance || task.protocol !== 'modbus-tcp' || typeof task.id !== 'string' || (id && task.id !== id)) {
      throw new Error('诊断结果与当前实例不匹配');
    }
    return task;
  }
  async function cancelDetached(task: ProtocolDiagnosticTask) {
    if (task.cleanup !== 'done') await port.cancel(task.instanceId, task.id).catch(() => undefined);
  }
  function schedule() {
    clearTimer();
    if (!disposed && diagnosticRunning(state.task) && !state.error) timer = setTimeout(() => { void refresh(); }, 1000);
  }
  async function load(ticket: number, instance: string) {
    const tasks = await port.list(instance);
    if (!current(ticket)) return;
    const active = tasks.find(task => task.cleanup !== 'done');
    update({ task: active ? validate(active, instance) : null, pending: false, error: '' });
    schedule();
  }
  async function select(instance: string) {
    if (disposed) return;
    const previous = state.task, ticket = ++epoch;
    clearTimer(); instanceId = instance; update({ task: null, pending: Boolean(instance), error: '' });
    if (previous && previous.instanceId !== instance) void cancelDetached(previous);
    if (!instance) return;
    try { await load(ticket, instance); }
    catch (error) { if (current(ticket)) update({ pending: false, error: errorText(error, '暂时无法查询该实例的试读任务，请刷新后重试。') }); }
  }
  async function start(connection: ModbusReadConnection) {
    if (disposed || !instanceId || state.pending || (state.task && state.task.cleanup !== 'done')) return;
    const ticket = ++epoch, instance = instanceId;
    clearTimer(); update({ task: null, pending: true, error: '' });
    try {
      const task = validate(await port.start(instance, connection), instance);
      if (!current(ticket)) { await cancelDetached(task); return; }
      update({ task, pending: false }); schedule();
    } catch (error) {
      if (!current(ticket)) return;
      update({ pending: false, error: errorText(error, '试读请求未能确认，请刷新任务状态后重试。') });
      // A lost response may still have created a job. Discover it, never resend.
      try {
        const tasks = await port.list(instance);
        const active = tasks.find(task => task.cleanup !== 'done');
        if (current(ticket) && active) { update({ task: validate(active, instance), error: '' }); schedule(); }
      } catch { /* Original failure stays visible; no read is repeated. */ }
    }
  }
  async function refresh() {
    if (disposed || !instanceId || state.pending || pollingEpoch === epoch) return;
    clearTimer();
    const ticket = epoch, instance = instanceId, task = state.task;
    pollingEpoch = ticket;
    try {
      if (!task) await load(ticket, instance);
      else {
        const next = validate(await port.get(instance, task.id), instance, task.id);
        if (current(ticket)) { update({ task: next, error: '' }); schedule(); }
      }
    } catch (error) {
      if (current(ticket)) update({ error: errorText(error, '暂时无法刷新试读状态，可重新查询或取消；请勿把状态未知当作读取成功。') });
    } finally { if (pollingEpoch === ticket) pollingEpoch = undefined; }
  }
  async function cancel() {
    if (disposed || state.pending || !state.task || state.task.cleanup === 'done') return;
    const task = state.task, ticket = ++epoch;
    clearTimer(); update({ pending: true, error: '' });
    try {
      const next = validate(await port.cancel(task.instanceId, task.id), task.instanceId, task.id);
      if (current(ticket)) { update({ task: next, pending: false }); schedule(); }
    } catch (error) {
      if (current(ticket)) update({ pending: false, error: errorText(error, '取消或清理结果未确认，请重新查询并重试清理。') });
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; epoch++; clearTimer();
    if (state.task) void cancelDetached(state.task);
  }
  return { get state() { return state; }, select, start, refresh, cancel, dispose };
}
