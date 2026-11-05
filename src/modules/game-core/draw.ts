/**
 * Provably-fair draw pipeline (FR-GAME-04, FR-GAME-07, UC-06).
 *
 * Lifecycle:
 *   1. LOCK  — server generates serverSeed + salt, publishes commitment =
 *              sha256(serverSeed + ":" + salt); clientSeedContribution =
 *              sha256(sorted ticket ids) so players provably influence the
 *              shuffle; seed sealed (AES-GCM) until completion.
 *   2. DRAW  — balls produced by SeedRng shuffle (engine, async, 1 per tick).
 *   3. REVEAL — on completion the seed and salt are published; anyone can
 *              regenerate the exact sequence and the award table.
 */
import { aesDecrypt, aesEncrypt, sha256Hex, secureHex } from "../../lib/crypto";
import { SeedRng } from "./rng";
import { gridSpec } from "./variants";

export interface DrawCommitment {
  commitment: string; // sha256(serverSeed + ":" + salt)
  clientSeedContribution: string;
  salt: string; // revealed only at completion
  serverSeedSealed: string; // AES envelope, revealed at completion
  nonce: number;
}

export function makeCommitment(sortedTicketIds: string[]): DrawCommitment {
  const serverSeed = secureHex(32);
  const salt = secureHex(16);
  return {
    commitment: sha256Hex(`${serverSeed}:${salt}`),
    clientSeedContribution: sha256Hex(sortedTicketIds.join(",")),
    salt,
    serverSeedSealed: aesEncrypt(serverSeed),
    nonce: 0,
  };
}

/** Full deterministic draw sequence (used by engine and verifier alike). */
export async function generateDrawSequence(
  serverSeedHex: string,
  salt: string,
  clientSeedContribution: string,
  nonce: number,
  variantId: string
): Promise<number[]> {
  const spec = gridSpec(variantId);
  const rng = new SeedRng(serverSeedHex, salt, clientSeedContribution, nonce);
  const universe = Array.from({ length: spec.ballsTotal }, (_, i) => i + 1);
  return rng.shuffle(universe);
}

export function openSealedSeed(sealed: string): string {
  return aesDecrypt(sealed);
}

/** Public verification payload for UC-06 pages. */
export interface RevealPayload {
  commitment: string;
  serverSeed: string;
  salt: string;
  clientSeedContribution: string;
  nonce: number;
  drawSequence: number[];
}

export async function buildReveal(
  seal: { commitment: string; clientSeedContribution: string; salt: string; serverSeedSealed: string; nonce: number },
  variantId: string
): Promise<RevealPayload> {
  const serverSeed = openSealedSeed(seal.serverSeedSealed);
  const drawSequence = await generateDrawSequence(serverSeed, seal.salt, seal.clientSeedContribution, seal.nonce, variantId);
  return {
    commitment: seal.commitment,
    serverSeed,
    salt: seal.salt,
    clientSeedContribution: seal.clientSeedContribution,
    nonce: seal.nonce,
    drawSequence,
  };
}

/** Independent check: does the commitment bind (seed, salt)? */
export function commitmentHolds(commitment: string, serverSeed: string, salt: string): boolean {
  return sha256Hex(`${serverSeed}:${salt}`) === commitment;
}
