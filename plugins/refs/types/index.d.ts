/** Your answer to a code: a line `A2: yes` in the prompt. */
export type Answer = 'yes' | 'no' | 'defer'

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
}

/** A side question about one code, answered in the pane and kept out of the conversation. */
export type Aside = {
  code: string
  status: 'asking' | 'answered' | 'failed'
  /** The answer, or why there is none. */
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    refs: {
      codes: Ref[]
      /** Answers in the prompt draft now, by code: they follow the draft as you edit it. */
      staged: Record<string, Answer>
      /** Answers already sent in a prompt, by code. */
      sent: Record<string, Answer>
      asides: Aside[]
      /** The pane's search text. */
      query: string
    }
  }
}
