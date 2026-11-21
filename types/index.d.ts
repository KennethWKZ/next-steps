// The last list offered, kept in $.state so a hot reload (/reload-plugins)
// finds it again: a number sent from a phone right after a reload still
// swaps. `sessionId` ties it to the session it was offered in, since
// $.state can outlive a /clear, which starts a new session id.
export type SavedList = {
  sessionId: string
  items: { label: string; prompt: string }[]
  picked: boolean[]
  // Whether the list was showing (an offer, not dismissed or sent over).
  isUp: boolean
}

// One list drawn as a transcript row: the row's id and its lines (header,
// then one per suggestion), as listLines made them.
export type PlacedList = { id: string; lines: string[] }

declare module 'claude-code' {
  interface PluginState {
    // list: the last list. lowEffortOff: the session id where the fork's
    // `effort: 'low'` was found to make a second cache copy; off there.
    // placed: the lists drawn as transcript rows ($.ui.place), newest last,
    // each under its row's id, so a row still draws after a reload.
    'next-steps': {
      list: Shaped<SavedList | null>
      lowEffortOff: Shaped<string | null>
      placed: Shaped<PlacedList[]>
    }
  }
}
