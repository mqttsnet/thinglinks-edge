/** Empty service selects legacy records; omitted service leaves the caller's documented default. */
export function fieldQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && (value !== '' || key === 'serviceCode')) query.set(key, value);
  }
  return query.size ? '?' + query.toString() : '';
}
