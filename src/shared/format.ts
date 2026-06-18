/**
 * Human-readable byte size using decimal (SI) units, matching ncdu's headline
 * figures (e.g. 30,063,550,528 → "30.1 GB").
 */
/**
 * Compact "expires in …" label from an ISO timestamp, relative to `now`
 * (injectable for tests). Returns "expired" once the time has passed.
 */
export function relativeExpiry(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days >= 1) return `expires in ${days}d ${hours}h`;
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 1) return `expires in ${hours}h ${mins}m`;
  return `expires in ${mins}m`;
}

export function humanBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = n;
  let unit = -1;
  do {
    value /= 1000;
    unit++;
  } while (value >= 1000 && unit < units.length - 1);
  return `${value.toFixed(digits)} ${units[unit]}`;
}
