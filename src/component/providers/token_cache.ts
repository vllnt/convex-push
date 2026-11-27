import { deriveCacheKey, open, type Sealed, seal } from "../crypto/token_seal.js";
import type { SendResult } from "../validators.js";

/** A freshly minted provider token and when to stop using it. */
export type Minted =
  | { ok: false; result: SendResult }
  | { ok: true; token: string; refreshAfter: number; expiresAt: number };

/** A token from the cache, or the sender result to return when none can be had. */
export type TokenRead = { ok: false; result: SendResult } | { ok: true; token: string };

/** A stored cache row, as the storage callbacks see it. */
export interface StoredToken extends Sealed {
  refreshAfter: number;
  expiresAt: number;
}

/** Which cached token: a credential fingerprint, plus the push service origin for VAPID. */
export interface TokenSlot {
  credentialRef: string;
  audience?: string;
}

/** Storage the cache runs on. The action wires these to internal queries and mutations. */
export interface TokenStorage {
  load(slot: TokenSlot): Promise<StoredToken | null>;
  /** Store a minted token. Keeps a fresher row written by a concurrent sender and returns the row that won. */
  store(slot: TokenSlot, row: StoredToken & { mintedAt: number }): Promise<Sealed>;
  drop(slot: TokenSlot): Promise<void>;
}

/** The shared provider-token cache used by every built-in sender. */
export interface TokenCache {
  get(slot: TokenSlot, secret: string, mint: () => Promise<Minted>): Promise<TokenRead>;
  drop(slot: TokenSlot): Promise<void>;
}

function aadFor(slot: TokenSlot): string {
  return `${slot.credentialRef}|${slot.audience ?? ""}`;
}

/**
 * Build the cache. Tokens are stored encrypted under a key derived from the
 * long-lived private key; a stored token is reused until `refreshAfter`. When
 * a refresh fails, a stored token that has not expired is still used.
 * @param storage - Load, store and drop callbacks.
 * @param now - Clock.
 * @returns The cache.
 */
export function createTokenCache(storage: TokenStorage, now: () => number): TokenCache {
  return {
    async get(slot, secret, mint) {
      const key = await deriveCacheKey(secret, slot.credentialRef);
      const aad = aadFor(slot);
      const row = await storage.load(slot);
      const cached = row && now() < row.expiresAt ? await open(key, row, aad) : null;
      if (cached && row && now() < row.refreshAfter) return { ok: true, token: cached };
      const minted = await mint();
      if (!minted.ok) return cached ? { ok: true, token: cached } : minted;
      const sealed = await seal(key, minted.token, aad);
      const winner = await storage.store(slot, {
        ...sealed,
        mintedAt: now(),
        refreshAfter: minted.refreshAfter,
        expiresAt: minted.expiresAt,
      });
      return { ok: true, token: (await open(key, winner, aad)) ?? minted.token };
    },
    drop: (slot) => storage.drop(slot),
  };
}
