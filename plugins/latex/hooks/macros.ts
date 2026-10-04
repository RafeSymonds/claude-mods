import type { Macro } from '../types'

// The reading position over a TeX source, shared by the parse and expand steps.
type Cursor = { src: string; at: number }

const MAX_PASSES = 20

function skipSpace(c: Cursor): void {
  while (c.at < c.src.length && /\s/.test(c.src[c.at] ?? '')) c.at++
}

/** A `{...}` group's inside, braces balanced; undefined when no group starts here. */
export function readGroup(c: Cursor): string | undefined {
  skipSpace(c)
  if (c.src[c.at] !== '{') return undefined
  let depth = 0
  const start = c.at + 1
  for (; c.at < c.src.length; c.at++) {
    const ch = c.src[c.at]
    if (ch === '\\') {
      c.at++
      continue
    }
    if (ch === '{') depth++
    if (ch === '}' && --depth === 0) return c.src.slice(start, c.at++)
  }

  return c.src.slice(start)
}

/** One argument as TeX reads it: a group's inside, a command, or one character. */
export function readArg(c: Cursor): string {
  const group = readGroup(c)
  if (group !== undefined) return group
  const command = /^\\([A-Za-z]+|.)/.exec(c.src.slice(c.at))
  if (command !== null) {
    c.at += command[0].length

    return command[0]
  }

  return c.src[c.at++] ?? ''
}

/** A `[...]` option's inside, or undefined when none starts here. */
export function readOption(c: Cursor): string | undefined {
  skipSpace(c)
  if (c.src[c.at] !== '[') return undefined
  const end = c.src.indexOf(']', c.at)
  if (end === -1) return undefined
  const inside = c.src.slice(c.at + 1, end)
  c.at = end + 1

  return inside
}

/** The macro name a definition names, `{\name}` or `\name`, without its backslash. */
function readName(c: Cursor): string | undefined {
  const name = /^\\([A-Za-z]+)/.exec(readArg(c))

  return name?.[1]
}

function stripComments(tex: string): string {
  return tex.replace(/(^|[^\\])%.*$/gm, '$1')
}

/**
 * The macros a header defines: `\newcommand` and its kin, `\def` without
 * parameters, `\DeclareMathOperator` and `\DeclarePairedDelimiter`. A later
 * definition of a name replaces an earlier one, as in one document.
 */
export function parseHeader(tex: string): Macro[] {
  const c: Cursor = { src: stripComments(tex), at: 0 }
  const byName = new Map<string, Macro>()
  const START = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|DeclarePairedDelimiter|def)(\*?)/g

  for (let match = START.exec(c.src); match !== null; match = START.exec(c.src)) {
    c.at = START.lastIndex
    const [, kind, star] = match
    const name = readName(c)
    if (name === undefined) continue

    if (kind === 'DeclareMathOperator') {
      byName.set(name, { name, args: 0, body: `\\operatorname${star}{${readArg(c)}}` })
    } else if (kind === 'DeclarePairedDelimiter') {
      const left = readArg(c)
      byName.set(name, { name, args: 1, body: '#1', left, right: readArg(c) })
    } else if (kind === 'def') {
      const body = readGroup(c)
      if (body !== undefined) byName.set(name, { name, args: 0, body })
    } else {
      const args = Number(readOption(c) ?? 0)
      readOption(c) // An optional first argument's default; that argument is read as a required one.
      const body = readGroup(c)
      if (body !== undefined) byName.set(name, { name, args, body })
    }
    START.lastIndex = c.at
  }

  return [...byName.values()]
}

/** One expansion of the macro at `c.at` (just past its name), from its arguments. */
function expandOne(macro: Macro, c: Cursor): string {
  if (macro.left !== undefined && macro.right !== undefined) {
    // A paired delimiter takes a star (sized to fit) or a size option, then its argument.
    const isSized = c.src[c.at] === '*'
    if (isSized) c.at++
    readOption(c)
    const inside = readArg(c)
    // A delimiter spelled as a command (`\lvert`) needs a space before a letter.
    const gap = /[A-Za-z]$/.test(macro.left) ? ' ' : ''

    return isSized
      ? `\\left${macro.left}${gap}${inside}\\right${macro.right}`
      : `${macro.left}${gap}${inside}${macro.right}`
  }
  const args = Array.from({ length: macro.args }, () => readArg(c))

  return macro.body.replace(/#([1-9])/g, (_, n: string) => args[Number(n) - 1] ?? '')
}

/** `tex` with every macro in `macros` expanded, nested ones too; `\ensuremath{x}` is `x`. */
export function expand(tex: string, macros: readonly Macro[]): string {
  const byName = new Map(macros.map(macro => [macro.name, macro]))
  let current = tex

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const c: Cursor = { src: current, at: 0 }
    let out = ''
    let isChanged = false

    while (c.at < c.src.length) {
      const command = /^\\([A-Za-z]+)/.exec(c.src.slice(c.at))
      if (command === null) {
        // An escaped character, `\\` included, is copied whole so its backslash starts nothing.
        const width = c.src[c.at] === '\\' ? 2 : 1
        out += c.src.slice(c.at, c.at + width)
        c.at += width
        continue
      }
      const name = command[1] ?? ''
      const macro = byName.get(name)
      c.at += command[0].length
      if (name === 'ensuremath') {
        out += readArg(c)
        isChanged = true
      } else if (macro !== undefined) {
        // A space keeps an expansion ending in a command from fusing with letters after it.
        out += `${expandOne(macro, c)}${/^[A-Za-z]/.test(c.src.slice(c.at)) ? ' ' : ''}`
        isChanged = true
      } else {
        out += command[0]
      }
    }
    current = out
    if (!isChanged) break
  }

  return current
}
