/**
 * Seeded deterministic stream RNG for provably-fair draws (FR-GAME-04, UC-06).
 *
 * The draw sequence is fully determined by (serverSeed, salt, clientSeed,
 * nonce): HMAC-SHA256 keyed by the server seed over a counter message
 * produces an endless byte stream; `nextInt` uses rejection sampling so the
 * distribution is uniform (no modulo bias). One implementation, run anywhere:
 * the engine generates, and the verification page regenerates in the browser
 * with the exact same code path.
 */
const encoder = new TextEncoder();

export class SeedRng {
  private counter = 0;
  private buffer: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private keyCache: CryptoKey | null = null;

  constructor(
    readonly serverSeedHex: string,
    readonly salt: string,
    readonly clientSeedContribution: string,
    readonly nonce: number
  ) {}

  private async key(): Promise<CryptoKey> {
    if (!this.keyCache) {
      const raw = Uint8Array.from(
        (this.serverSeedHex + this.nonce.toString(16).padStart(8, "0")).match(/.{2}/g)!.map((h) => parseInt(h, 16))
      );
      this.keyCache = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    }
    return this.keyCache;
  }

  private async refill(): Promise<void> {
    const key = await this.key();
    const msg = encoder.encode(`${this.salt}:${this.clientSeedContribution}:${this.counter++}`);
    const sig = await crypto.subtle.sign("HMAC", key, msg);
    this.buffer = new Uint8Array(sig);
    this.offset = 0;
  }

  private async nextByte(): Promise<number> {
    if (this.offset >= this.buffer.length) await this.refill();
    return this.buffer[this.offset++];
  }

  /** Uniform integer in [0, maxExclusive) via rejection sampling. */
  async nextInt(maxExclusive: number): Promise<number> {
    if (maxExclusive <= 0) throw new Error("RNG_MAX_MUST_BE_POSITIVE");
    // Largest power of two below max, then reject above the fair ceiling.
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    for (;;) {
      const b0 = await this.nextByte();
      const b1 = await this.nextByte();
      const b2 = await this.nextByte();
      const b3 = await this.nextByte();
      const value = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
      if (value < limit) return value % maxExclusive;
    }
  }

  /** Fisher–Yates shuffle driven by the stream → the ball order itself. */
  async shuffle<T>(items: T[]): Promise<T[]> {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = await this.nextInt(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}
