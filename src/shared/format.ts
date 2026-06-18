/**
 * Human-readable byte size using decimal (SI) units, matching ncdu's headline
 * figures (e.g. 30,063,550,528 → "30.1 GB").
 */
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
