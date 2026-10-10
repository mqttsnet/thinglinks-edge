/** Internal binding shape. secretEnc is never included in API projections. */
export interface HttpDeviceBinding {
  id: string;
  instanceId: string;
  targetPath: string;
  deviceId: string;
  secretEnc: string;
  enabled: boolean;
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  flowRevision: string;
}

export class IngressError extends Error {
  readonly status: number;
  readonly headers?: Record<string, string>;
  constructor(status: number, message: string, headers?: Record<string, string>) {
    super(message);
    this.name = 'IngressError';
    this.status = status;
    if (headers !== undefined) this.headers = headers;
  }
}
