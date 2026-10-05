/**
 * Where a quick answer sits in a code's row: go (fix, approve, pick, do) or
 * stop (ignore, reject, drop, skip), its word set by the code's kind; or later,
 * the defer every kind shares, which parks the code.
 */
export type Slot = 'go' | 'stop' | 'later'

/** One reference code as Claude first defined it in the conversation. */
export type Ref = {
  /** The code as written: `F1`, `RP3`. */
  code: string
  /** Its letters: `F`, `RP`. */
  prefix: string
  /** Its number. */
  n: number
  /** The text that followed the code where it was defined. */
  text: string
  /** The reply that defined it: options from one reply are one set, picked one of. */
  set?: string
  /** The heading or bold label above it in that reply: a name for a letter no setting names. */
  section?: string
  /** The turn whose reply defined it, counting from 1: how new it is. */
  turn?: number
}

/** A side question about one code, answered in the pane and kept out of the conversation. */
export type Aside = {
  code: string
  /** What you asked; the default asks to explain the code in more depth. */
  question: string
  status: 'asking' | 'answered' | 'failed'
  /** The answer, or why there is none. */
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    refs: {
      codes: Ref[]
      /** Answers in the prompt draft now, by code: yes, no, defer or typed text. They follow the draft as you edit it. */
      staged: Record<string, string>
      /** Answers already sent in a prompt, by code. */
      sent: Record<string, string>
      asides: Aside[]
      /** The pane's search text. */
      query: string
      /** The code the keyboard acts on, or ''. */
      selected: string
      /** The code whose answer field is open, or ''. */
      typing: string
      /** The code whose btw question field is open, or ''. */
      asking: string
      /** The groups folded to their header, by letters: `F`, `A`. */
      folded: string[]
      /** How many turns this conversation has had: a code from this turn is the newest. */
      turn: number
      /** Codes deferred: off the list, under Deferred, and written to the deferred file. */
      parked: string[]
      /** Whether the Deferred group is open. */
      showDeferred: boolean
    }
  }
}
