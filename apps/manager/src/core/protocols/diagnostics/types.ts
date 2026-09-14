export interface ModbusDiagnosticConnection {
  host: string;
  port: number;
  unitId: number;
  registerType: 'HoldingRegister' | 'InputRegister';
  address: number;
  quantity: number;
  clientTimeout: number;
  reconnectTimeout: number;
}
export type DiagnosticState = 'preparing' | 'connecting' | 'reading' | 'succeeded' | 'failed' | 'cancelled' | 'cleanup-required';
export type DiagnosticCleanup = 'pending' | 'done' | 'failed';
export interface DiagnosticResult {
  registers: number[];
  hex: string;
  durationMs: number;
}
export interface DiagnosticFailure {
  code: string;
  message: string;
}
export interface ProtocolDiagnosticTask {
  id: string;
  instanceId: string;
  protocol: 'modbus-tcp';
  connection: ModbusDiagnosticConnection;
  state: DiagnosticState;
  deadline: number;
  cleanup: DiagnosticCleanup;
  createdAt: number;
  finishedAt?: number;
  result?: DiagnosticResult;
  error?: DiagnosticFailure | undefined;
}
export class DiagnosticError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'DiagnosticError';
    this.code = code;
    this.status = status;
  }
}
export const DIAGNOSTIC_FAILURES = {
  CONNECT_FAILED: '未能连接设备，请检查地址、端口、站号及现场网络。',
  READ_TIMEOUT: '未在规定时间收到试读结果，请检查寄存器地址和读取超时。',
  READ_FAILED: '设备未完成本次寄存器读取，请检查寄存器类型与地址范围。',
  INVALID_RESPONSE: '设备返回的数据格式或寄存器数量与本次请求不一致。',
  COMPONENT_UNAVAILABLE: '实例尚未完整加载 node-red-contrib-modbus 5.60.2，请先安装并确认节点正常。',
  INSTANCE_UNAVAILABLE: '实例未运行或无法访问，请先确认实例状态。',
  CALLBACK_UNAVAILABLE: '实例回报通道未就绪，请先修复实例接入配置。',
  FLOW_GRAPH_UNREADABLE: '无法完整读取实例现有流程，未创建试读连接。请检查实例访问状态后重试。',
  FLOW_GRAPH_TOO_LARGE: '现有流程图超出安全读取容量或不足以容纳临时试读页，未创建连接。请先减少或拆分流程内容。',
  FLOW_DEPLOY_FAILED: '临时试读流程未能完成部署。',
  FLOW_CHANGED: '临时流程已被修改或被其他流程引用，不能自动删除；请检查后重试清理。',
  CLEANUP_FAILED: '临时试读连接尚未清理，仍可能重连；请重试清理后再试读。',
  INSTANCE_CHANGED: '实例已更换或身份无法确认，不能删除其他实例中的流程。',
  INTERRUPTED: '试读因 Manager 重启或关闭而中止，不会自动重放读取。',
} as const;
export type DiagnosticFailureCode = keyof typeof DIAGNOSTIC_FAILURES;
export const diagnosticFailure = (code: DiagnosticFailureCode): DiagnosticFailure => ({ code, message: DIAGNOSTIC_FAILURES[code] });
