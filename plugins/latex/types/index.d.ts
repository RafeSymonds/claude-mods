/** One macro a LaTeX header defines, ready to expand. */
export type Macro = {
  /** The name without its backslash: `msgspace`. */
  name: string
  /** How many arguments it takes. */
  args: number
  /** What it expands to, `#1`... standing for its arguments. */
  body: string
  /** A paired delimiter's left and right (`\DeclarePairedDelimiter`). */
  left?: string
  right?: string
}

declare module 'claude-code' {
  interface PluginState {
    latex: { macros: Macro[]; sources: string[] }
  }
}
