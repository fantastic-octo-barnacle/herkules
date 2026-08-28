/**
 * Sealed cookie values. The only module that touches key material.
 *
 * Format: `v1.` + base64url(iv(12) || ciphertext || tag(16)), AES-256-GCM.
 * Key: HKDF-SHA256(ikm = cookieSecret, salt = clientId, info = purpose), so
 * two apps sharing a secret cannot open each other's cookies and a login blob
 * can never open as a session blob (purpose is also bound as AAD). Unknown
 * version, wrong purpose, wrong key or a flipped byte all read as `undefined`:
 * the caller treats every failure as "no cookie". WebCrypto only; no deps.
 *
 * Rotating `cookieSecret` invalidates every cookie at once. That is the
 * emergency lever, not a bug; there is no key-overlap machinery by design.
 */

export type Purpose = "session" | "login";

/** A sealed string that may only be opened as `P`. Produced by `Sealer.seal`, never by hand. */
export type Sealed<P extends Purpose> = string & { readonly __sealed: P };

export interface Sealer {
  seal<P extends Purpose>(purpose: P, plaintext: Uint8Array): Promise<Sealed<P>>;
  /** `undefined` on any failure. Never throws on untrusted input. */
  open<P extends Purpose>(purpose: P, value: string): Promise<Uint8Array | undefined>;
}

export const SEAL_VERSION = "v1";
export const MIN_SECRET_LENGTH = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
/** WebCrypto's key handle, named through the API so no DOM lib is needed. */
type CryptoKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

/**
 * Derives one AES-256-GCM key per purpose (two HKDF runs, cached on first
 * use), so per-request cost is one AEAD operation.
 * @throws TypeError when `secret` is shorter than 32 characters or `salt` is empty.
 */
export function createSealer(secret: string, salt: string): Sealer {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`cookie secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (typeof salt !== "string" || salt.length === 0) {
    throw new TypeError("seal salt must be a non-empty string");
  }
  const subtle = globalThis.crypto.subtle;
  let ikm: Promise<CryptoKey> | undefined;
  const keys = new Map<Purpose, Promise<CryptoKey>>();

  const keyFor = (purpose: Purpose): Promise<CryptoKey> => {
    const cached = keys.get(purpose);
    if (cached) return cached;
    ikm ??= subtle.importKey("raw", utf8(secret), "HKDF", false, ["deriveKey"]);
    const derived = ikm.then((material) =>
      subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: utf8(salt), info: utf8(purpose) },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    );
    keys.set(purpose, derived);
    return derived;
  };

  return {
    async seal(purpose, plaintext) {
      const key = await keyFor(purpose);
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ct = new Uint8Array(
        await subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: utf8(purpose) },
          key,
          plaintext,
        ),
      );
      const out = new Uint8Array(IV_BYTES + ct.length);
      out.set(iv, 0);
      out.set(ct, IV_BYTES);
      return `${SEAL_VERSION}.${Buffer.from(out).toString("base64url")}` as Sealed<typeof purpose>;
    },
    async open(purpose, value) {
      if (typeof value !== "string") return undefined;
      const dot = value.indexOf(".");
      if (dot < 0 || value.slice(0, dot) !== SEAL_VERSION) return undefined;
      const bytes = Buffer.from(value.slice(dot + 1), "base64url");
      if (bytes.length < IV_BYTES + TAG_BYTES) return undefined;
      try {
        const key = await keyFor(purpose);
        const plain = await subtle.decrypt(
          { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: utf8(purpose) },
          key,
          bytes.subarray(IV_BYTES),
        );
        return new Uint8Array(plain);
      } catch {
        return undefined;
      }
    },
  };
}
