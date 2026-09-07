/** Clear stale records only after both immutable id and original name prove absent. */
export async function reconcileAbsentResources(ledger, { inspectById, inspectByName }, label) {
  const errors = [];
  // A snapshot bounds this pass to the identities present when reconciliation started.
  for (const [name, id] of [...ledger]) {
    try {
      const byId = await inspectById(id);
      const byName = await inspectByName(name);
      const present = [];
      if (byId !== undefined) present.push('recorded id still exists');
      if (byName !== undefined) present.push('resource name still exists');
      if (present.length) throw new Error(present.join(', '));
      if (ledger.get(name) !== id) throw new Error('ledger identity changed during inspection');
      ledger.delete(name);
    } catch (cause) {
      errors.push(new Error(`${label} ${name} (${id}): ${cause?.message ?? String(cause)}`, { cause }));
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, errors.map((error) => error.message).join('; '));
  }
}
