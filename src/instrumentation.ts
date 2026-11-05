/**
 * Next.js instrumentation hook — runs once per server process start.
 * This is where the game engine (room grain turns) is booted on the nodejs
 * runtime. Guarded by a globalThis flag inside bootEngine() against
 * hot-reload double boots.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootEngine } = await import("./modules/engine");
    bootEngine();
  }
}
