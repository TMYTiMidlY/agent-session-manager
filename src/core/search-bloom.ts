/** A conservative UTF16 trigram Bloom filter: false positives are allowed, never negatives. */
export const BLOOM_BYTES = 32 * 1024;
const MASK = BLOOM_BYTES * 8 - 1;

function positions(text: string, index: number, out: Uint32Array): void {
  const a = text.charCodeAt(index), b = text.charCodeAt(index + 1), c = text.charCodeAt(index + 2);
  const first = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b) ^ Math.imul(c, 0xc2b2ae35);
  const step = ((first >>> 17) ^ Math.imul(a + c, 0x27d4eb2d) ^ b) | 1;
  out[0] = first & MASK;
  out[1] = (first + step) & MASK;
  out[2] = (first + 2 * step) & MASK;
}

export function buildSearchBloom(lowerTexts: readonly string[]): Buffer {
  const bits = Buffer.alloc(BLOOM_BYTES);
  const indices = new Uint32Array(3);
  for (const text of lowerTexts) {
    for (let i = 0; i + 2 < text.length; i++) {
      positions(text, i, indices);
      for (let j = 0; j < 3; j++) { const bit = indices[j]; bits[bit >>> 3] |= 1 << (bit & 7); }
    }
  }
  return bits;
}

export function bloomMayContain(bits: Buffer, lowerQuery: string): boolean {
  if (bits.length !== BLOOM_BYTES) return true;
  const indices = new Uint32Array(3);
  for (let i = 0; i + 2 < lowerQuery.length; i++) {
    positions(lowerQuery, i, indices);
    for (let j = 0; j < 3; j++) { const bit = indices[j]; if (!(bits[bit >>> 3] & (1 << (bit & 7)))) return false; }
  }
  return true;
}
