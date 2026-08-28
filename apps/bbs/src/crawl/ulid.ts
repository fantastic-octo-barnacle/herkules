/**
 * ULID minting for rows the crawler creates (articles, article_links,
 * article_images, poll_runs). rm-wenku minted ULIDs; keeping the format keeps
 * `id DESC` a time-ordered tiebreak across imported and crawled rows.
 * 48-bit millisecond time + 80 random bits, Crockford base32, 26 chars.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(nowMs: number): string {
  let time = Math.floor(nowMs);
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[time % 32]! + out;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(10);
  // 80 bits → 16 base32 chars: walk a bit cursor over the buffer.
  let bits = 0;
  let acc = 0;
  let rand = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      rand += ALPHABET[(acc >>> (bits - 5)) & 31]!;
      bits -= 5;
      acc &= (1 << bits) - 1;
    }
  }
  return out + rand;
}
