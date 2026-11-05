/**
 * game-core — pure game domain (FR-GAME). No database, no transport: the same
 * code runs in the Next.js API, the game-gateway engine, and inside the
 * player's browser for fairness verification (UC-06).
 */
export * from "./variants";
export * from "./cards";
export * from "./rng";
export * from "./draw";
export * from "./patterns";
