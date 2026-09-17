import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

/**
 * Which WindBreak view owns the surface, if either does.
 *
 * Two views now read the same engine — `/scan` runs a scan on screen (§20.36) and `/windbreak`
 * works the adjudication queue it produces. They are one takeover with two faces, so they share
 * one flag rather than getting a boolean each: two booleans can both be true, and the render is a
 * ternary, so the second one would be silently unreachable and closing the first would reveal a
 * view the researcher did not open.
 *
 * The same shape as `review-store.ts`, and for the same reason: a takeover view and the composer
 * cannot both claim the keyboard. `chat.tsx` reads it to disable the composer, close the queue
 * panel behind it, collapse the ad dock and render the view in the transcript's place — the four
 * things `reviewMode` already does.
 *
 * The *state* of each view stays with the view. The scan's log belongs to the run in flight and
 * the queue's selection belongs to the session it was read from; a store that held either would
 * outlive the thing that can finish it, leaving the next session opening onto a run nothing is
 * driving or a queue read from a database that has since changed.
 */
export type WindbreakView = 'scan' | 'queue'

interface WindbreakViewState {
  windbreakView: WindbreakView | null
  openScanView: () => void
  openQueueView: () => void
  closeWindbreakView: () => void
}

export const useWindbreakViewStore = create<WindbreakViewState>()(
  immer((set) => ({
    windbreakView: null,
    openScanView: () => {
      set((state) => {
        state.windbreakView = 'scan'
      })
    },
    openQueueView: () => {
      set((state) => {
        state.windbreakView = 'queue'
      })
    },
    closeWindbreakView: () => {
      set((state) => {
        state.windbreakView = null
      })
    },
  })),
)
