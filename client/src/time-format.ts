// Building an Intl formatter costs far more than using one, and lists that
// show timestamps re-render on every keystroke, selection, and refetch — so
// there is one formatter, and each distinct timestamp is rendered once.
const TIMESTAMP_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const TIMESTAMP_LABELS = new Map<string, string>();
const TIMESTAMP_CACHE_LIMIT = 500;

/** Locale date and time for an ISO timestamp. */
export function formatTimestamp(value: string): string {
  const cached = TIMESTAMP_LABELS.get(value);
  if (cached !== undefined) return cached;
  const label = TIMESTAMP_FORMAT.format(new Date(value));
  if (TIMESTAMP_LABELS.size >= TIMESTAMP_CACHE_LIMIT) TIMESTAMP_LABELS.clear();
  TIMESTAMP_LABELS.set(value, label);
  return label;
}
