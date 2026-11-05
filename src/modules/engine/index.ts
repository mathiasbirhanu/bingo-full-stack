/**
 * engine — the game-gateway process role (Architecture ch. 4.2): room grain
 * turns, commit-reveal draw driving, auto-daub award resolution, completion,
 * rolling scheduling. Booted by src/instrumentation.ts.
 */
export { bootEngine, engineStatus, tickAll } from "./boot";
export { buildRoomState, retireRoom } from "./lifecycle";
export { tickDrawing } from "./tick";
export { finishRoom } from "./finish";
export { roomState, dropRoomState, registrySize, type EngineRoomState, type EnginePattern } from "./state";
