'use client'

/**
 * Timer completion chime with gesture-primed audio unlock.
 *
 * Browsers block an AudioContext that was never touched during a user
 * gesture — a context created cold at completion time (minutes after the
 * last click) starts `suspended` and plays nothing. So we keep ONE shared
 * context, unlock it on the Start/Resume click (`primeTimerAudio`), and
 * reuse it when the countdown ends (`playTimerChime`). The module-level
 * singleton survives client-side navigation, so a timer started on /timers
 * still chimes from the app-wide bubble on any other page.
 *
 * Best-effort throughout: if the context was never unlocked (e.g. the tab was
 * closed and reopened), the chime is silently skipped.
 */

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (ctx) return ctx
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    ctx = new Ctor()
  } catch {
    ctx = null
  }
  return ctx
}

/** Call synchronously from a user gesture (a Start / Resume click) so the
 *  shared AudioContext is created + resumed while user activation is live. */
export function primeTimerAudio(): void {
  const c = getCtx()
  if (c && c.state === 'suspended') void c.resume().catch(() => {})
}

function twoTone(c: AudioContext): void {
  try {
    const beep = (freq: number, at: number) => {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.frequency.value = freq
      osc.type = 'sine'
      gain.gain.setValueAtTime(0.0001, c.currentTime + at)
      gain.gain.exponentialRampToValueAtTime(0.12, c.currentTime + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + at + 0.5)
      osc.connect(gain).connect(c.destination)
      osc.start(c.currentTime + at)
      osc.stop(c.currentTime + at + 0.55)
    }
    beep(880, 0)
    beep(1174.66, 0.25)
  } catch {
    // No audio / oscillator unavailable — the visual completion is the signal.
  }
}

/** Soft two-tone completion chime. Resumes the primed context first (a
 *  timer callback is not a gesture, but a previously-unlocked context can be
 *  resumed), then plays. Never throws. */
export function playTimerChime(): void {
  const c = getCtx()
  if (!c) return
  if (c.state === 'suspended') {
    c.resume()
      .then(() => twoTone(c))
      .catch(() => {})
  } else {
    twoTone(c)
  }
}
