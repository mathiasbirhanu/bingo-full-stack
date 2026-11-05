"use client";

/**
 * sfx — WebAudio-synthesized game sounds (Bingo-Blitz energy, FR-NFR
 * low-bandwidth: zero audio assets, a few KB of code instead of MB of files).
 *
 * Sounds: tap (button), ball (draw pop), daub (number marked), coin (money
 * landed), win (fanfare + coin cascade), error (invalid tap buzz), ready
 * (BINGO! button armed). The AudioContext unlocks on the first user gesture
 * (browser autoplay policy); the toggle persists in localStorage and
 * defaults ON.
 */

export type SfxName = "tap" | "ball" | "daub" | "coin" | "win" | "error" | "ready";

const STORAGE_KEY = "bingo.sound";

let ctx: AudioContext | null = null;
let unlocked = false;

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function sfxEnabled(): boolean {
  return loadEnabled();
}

export function setSfxEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* private mode — session-only */
  }
}

/** Idempotent — call on the first pointer gesture so playback is allowed. */
export function initSfx(): void {
  if (typeof window === "undefined") return;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  unlocked = true;
}

interface ToneOpts {
  freq: number;
  freqEnd?: number;
  t0: number; // seconds from now
  dur: number;
  type?: OscillatorType;
  gain?: number;
}

function tone({ freq, freqEnd, t0, dur, type = "sine", gain = 0.1 }: ToneOpts): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  const start = ctx.currentTime + t0;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), start + dur);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(amp).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** Fire a named sound. Silent no-op when disabled or not yet unlocked. */
export function playSfx(name: SfxName): void {
  if (!loadEnabled() || !unlocked || !ctx || ctx.state !== "running") return;
  switch (name) {
    case "tap":
      tone({ freq: 1350, t0: 0, dur: 0.05, gain: 0.06 });
      break;
    case "ball":
      // thock + rising pop — the drum spits the ball
      tone({ freq: 190, t0: 0, dur: 0.06, type: "sine", gain: 0.12 });
      tone({ freq: 480, freqEnd: 920, t0: 0.02, dur: 0.13, type: "triangle", gain: 0.13 });
      break;
    case "daub":
      tone({ freq: 640, freqEnd: 880, t0: 0, dur: 0.09, gain: 0.11 });
      break;
    case "coin":
      tone({ freq: 1720, t0: 0, dur: 0.08, gain: 0.09 });
      tone({ freq: 2280, t0: 0.055, dur: 0.07, gain: 0.07 });
      break;
    case "win": {
      // fanfare arpeggio C5-E5-G5-C6 + coin cascade
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => tone({ freq: f, t0: i * 0.11, dur: 0.3, type: "triangle", gain: 0.12 }));
      for (let i = 0; i < 7; i++) {
        tone({ freq: 1500 + Math.random() * 900, t0: 0.45 + i * 0.09, dur: 0.07, gain: 0.06 });
      }
      break;
    }
    case "error":
      // invalid tap — short low buzz
      tone({ freq: 170, freqEnd: 110, t0: 0, dur: 0.13, type: "square", gain: 0.05 });
      break;
    case "ready":
      // BINGO! armed — rising two-note chime
      tone({ freq: 880, t0: 0, dur: 0.09, type: "triangle", gain: 0.1 });
      tone({ freq: 1320, t0: 0.1, dur: 0.14, type: "triangle", gain: 0.1 });
      break;
    }
}
