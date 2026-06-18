const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Encode bytes as a big-endian base62 string (no padding). */
export function base62(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  if (n === 0n) return "0";
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

/**
 * A URL-safe, collision-resistant slug. 16 bytes = 128 bits of entropy →
 * ~22 base62 chars. Uses Web Crypto (available in workerd, browsers, Node).
 */
export function randomSlug(byteLength = 16): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base62(buf);
}
