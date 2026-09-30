/**
 * Local-device YYYY-MM-DD for date-valued fields like interaction_at.
 * toISOString() slices UTC, which rolls JST 00:00–08:59 back a day.
 */
export function localDateString(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
