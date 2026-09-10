export interface FieldValueDisplay { display: string; raw: string; approximate: boolean }

function rawText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Object.is(value, -0)) return '-0';
  if (['number', 'string', 'boolean'].includes(typeof value)) return String(value);
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/**
 * Compact only a long 0/9 tail when a shorter decimal differs by at most one floating-point step.
 * This is a display approximation, never a declared sensor precision: the caller must expose raw.
 */
export function formatFieldValue(value: unknown): FieldValueDisplay {
  const raw = rawText(value);
  const unchanged = { display: raw, raw, approximate: false };
  if (typeof value !== 'number' || !Number.isFinite(value) || Number.isInteger(value)) return unchanged;
  const mantissa = raw.split(/[eE]/)[0] ?? '';
  if (!mantissa.includes('.') || !/(?:0{6,}[1-9]\d{0,2}|9{6,}\d{0,2})$/.test(mantissa)) return unchanged;
  const step = Math.max(Number.MIN_VALUE, 2 ** (Math.floor(Math.log2(Math.abs(value))) - 52));
  for (let precision = 1; precision <= 15; precision++) {
    const candidate: number = Number(value.toPrecision(precision));
    if (candidate === value) break;
    if (candidate !== 0 && Math.abs(candidate - value) <= step) {
      return { display: String(candidate), raw, approximate: true };
    }
  }
  return unchanged;
}
