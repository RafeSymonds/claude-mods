/** Your answer to a code, staged in the prompt from the pane. */
export type Answer = 'yes' | 'no' | 'defer' | 'other'

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
  /** The last answer you gave it from the pane. */
  answer?: Answer
}

declare module 'claude-code' {
  interface PluginState {
    refs: { codes: Ref[] }
  }
}
