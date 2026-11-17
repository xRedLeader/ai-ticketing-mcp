export function serializeSuccessEnvelope(data: unknown): string {
  // Normalize first so toJSON, boxed primitives, and undefined retain standard JSON semantics.
  const envelope = JSON.parse(JSON.stringify({ ok: true, data, error: null }));
  return JSON.stringify(envelope, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
}
