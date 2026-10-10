import { MANAGED_FLOW_RESPONSE_MAX_BYTES, type SingleFlowConfig } from '../../flows/admin-client.ts';
import type { FlowNode } from '../../flows/types.ts';
import { DiagnosticError, diagnosticFailure } from './types.ts';

// Covers assigned tab IDs, separators and Node-RED's small added tab/config metadata.
const METADATA_RESERVE_BYTES = 16 * 1024;
const tooLarge = () => {
  const error = diagnosticFailure('FLOW_GRAPH_TOO_LARGE');
  return new DiagnosticError(error.code, error.message, 409);
};

/** Reserve the entire new flattened graph in UTF-8, including conservative JSON formatting. */
export function diagnosticFlowReadReservation(flow: SingleFlowConfig): number {
  const { nodes, configs = [], ...tab } = flow;
  const flat = [{ ...tab, type: 'tab' }, ...nodes, ...configs];
  const reservedBytes = Buffer.byteLength(JSON.stringify(flat, null, 4), 'utf8') + METADATA_RESERVE_BYTES;
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes >= MANAGED_FLOW_RESPONSE_MAX_BYTES) throw tooLarge();
  return reservedBytes;
}

/** Secondary validation for alternate admin ports; production also caps the raw response stream. */
export function assertDiagnosticGraphCapacity(flows: FlowNode[], reservedBytes: number): void {
  const existingBytes = Buffer.byteLength(JSON.stringify(flows), 'utf8');
  if (existingBytes + reservedBytes > MANAGED_FLOW_RESPONSE_MAX_BYTES) throw tooLarge();
}
