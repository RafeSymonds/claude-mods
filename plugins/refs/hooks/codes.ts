import type { Ref, Slot } from '../types'

// A defining code opens its line, after any quote, heading, list or table
// marker: `- **F1 Name:** text`, `### D2. text`, `1. A3: text`, `| R1 | text |`.
// Groups: opening markup, letters, number, closing markup, the rest.
const DEFINITION =
  /^\s*(?:[>#]+\s*)*(?:[-*+]\s+|\d+[.)]\s+|\|\s*)?([*_`]*)([A-Z]{1,3})(\d{1,3})(?!\w)([*_`]*)(.*)$/

// Without markup around the code, what follows must read as a label:
// punctuation or a capitalized word. "S3 bucket" stays prose.
const LABEL_START = /^(?:\s*$|\s*[:.)|–—-]|\s+[A-Z`"'([])/

// A cited code in a prompt, any case, with an optional range: `a2`, `A1-A3`, `f2–4`.
const CITE = /\b([A-Za-z]{1,3})(\d{1,3})(?:\s*[-–]\s*(?:\1)?(\d{1,3}))?\b/gi

const FENCE = /^\s*(```|~~~)/
// A line that names what follows: a heading, or a line that is all bold.
const SECTION = /^\s*(?:#{1,6}\s+(.+?)|\*\*([^*]+?)\*\*:?|__([^_]+?)__:?)\s*$/
const MAX_SECTION = 40
const MAX_TEXT = 240
const MAX_RANGE = 50

function cleanText(raw: string): string {
  return raw
    .replace(/^[\s:.)|–—*_`-]+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s*\|\s*$/, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT)
}

/** Every code a reply defines, first definition of each, in order. */
export function parse(markdown: string): Ref[] {
  const lines = markdown.split('\n')
  const found = new Map<string, Ref>()
  let isInFence = false
  let section: string | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (FENCE.test(line)) {
      isInFence = !isInFence
      continue
    }
    if (isInFence) continue

    const match = DEFINITION.exec(line)
    if (match === null) {
      const heading = SECTION.exec(line)
      const label = heading?.[1] ?? heading?.[2] ?? heading?.[3]
      if (label !== undefined) section = cleanText(label).replace(/:$/, '').slice(0, MAX_SECTION)
      continue
    }
    const [, open = '', prefix = '', digits = '', close = '', rest = ''] = match
    const isMarked = open !== '' || close !== '' || line.trimStart().startsWith('#')
    if (!isMarked && !LABEL_START.test(rest)) continue

    const code = prefix + digits
    if (found.has(code)) continue

    // A bare heading (`### F1`) keeps its text on the next line.
    let text = cleanText(rest)
    for (let j = i + 1; text === '' && j < lines.length; j++) {
      text = cleanText(lines[j] ?? '')
    }
    found.set(code, section === undefined ? { code, prefix, n: Number(digits), text } : { code, prefix, n: Number(digits), text, section })
  }

  return [...found.values()]
}

/** `list` then `found`, one ref per code: a code keeps its first definition. */
export function merge(list: readonly Ref[], found: readonly Ref[]): Ref[] {
  const byCode = new Map<string, Ref>()
  for (const ref of [...list, ...found]) {
    if (!byCode.has(ref.code)) byCode.set(ref.code, ref)
  }

  return [...byCode.values()]
}

/** The known refs a prompt cites, in the order cited; `a2` is `A2`. */
export function cited(text: string, list: readonly Ref[]): Ref[] {
  const byCode = new Map(list.map(ref => [ref.code, ref]))
  const hits = new Map<string, Ref>()

  for (const [, letters = '', from = '', to] of text.matchAll(CITE)) {
    const prefix = letters.toUpperCase()
    const first = Number(from)
    const last = to === undefined ? first : Number(to)
    const isRange = last > first && last - first <= MAX_RANGE

    for (let n = first; n <= (isRange ? last : first); n++) {
      const ref = byCode.get(`${prefix}${n}`)
      if (ref !== undefined) hits.set(ref.code, ref)
    }
  }

  return [...hits.values()]
}

/** The refs grouped by prefix, groups in first-seen order, each sorted by number. */
export function group(list: readonly Ref[]): { prefix: string; refs: Ref[] }[] {
  const groups = new Map<string, Ref[]>()
  for (const ref of list) groups.set(ref.prefix, [...(groups.get(ref.prefix) ?? []), ref])

  return [...groups].map(([prefix, refs]) => ({
    prefix,
    refs: refs.sort((a, b) => a.n - b.n),
  }))
}

/** The codes in use, runs compressed: `F1–F6, A1–A3, A5`. */
export function inUse(list: readonly Ref[]): string {
  const runs: string[] = []
  const run = (prefix: string, start: number, end: number) =>
    start === end ? `${prefix}${start}` : `${prefix}${start}–${prefix}${end}`

  for (const { prefix, refs } of group(list)) {
    let start: number | undefined
    let end = 0
    for (const { n } of refs) {
      if (start !== undefined && n === end + 1) {
        end = n
        continue
      }
      if (start !== undefined) runs.push(run(prefix, start, end))
      start = end = n
    }
    if (start !== undefined) runs.push(run(prefix, start, end))
  }

  return runs.join(', ')
}

/** The hidden note a prompt carries for the model once any code exists. */
export function contextBlock(list: readonly Ref[], hits: readonly Ref[]): string {
  const lines = [
    `Reference codes defined earlier in this conversation: ${inUse(list)}.`,
    'Keep each code bound to its item. Number new items after the highest code in use for their letter.',
  ]
  if (hits.length > 0) {
    lines.push('Codes cited in this prompt (case-insensitive, so a2 is A2):')
    for (const ref of hits) lines.push(`${ref.code}: ${ref.text}`)
  }

  return lines.join('\n')
}

// An answer line in a prompt: `A2: do`, or `A2:` and typed text, alone on its line.
const ANSWER_LINE = /^[ \t]*([A-Za-z]{1,3}\d{1,3}):[ \t]*(\S.*?)[ \t]*$/gm

/** A kind of code: what its group is called and its quick answers by slot. */
export type Kind = { name: string; verbs: Partial<Record<Slot, string>> }

/** The kinds by letter, and the answers of letters no kind names. */
export type Kinds = { byPrefix: Readonly<Record<string, Kind>>; otherVerbs: Partial<Record<Slot, string>> }

/** The six kinds CLAUDE.md names, as their settings read: a name, then up to three answers. */
export const KIND_DEFAULTS = {
  F: 'Findings: fix, ignore, later',
  D: 'Decisions: approve, reject, defer',
  O: 'Options: pick, drop',
  R: 'Risks: mitigate, accept, later',
  Q: 'Questions: yes, no',
  A: 'Actions: do, skip, later',
} as const
export const OTHER_ANSWERS_DEFAULT = 'yes, no, defer'

const SLOTS: readonly Slot[] = ['go', 'stop', 'later']

/** `fix, ignore, later`: the words fill go, stop and later in order. */
function parseWords(text: string): Partial<Record<Slot, string>> {
  const words = text
    .split(',')
    .map(word => word.trim().toLowerCase())
    .filter(word => word !== '')

  return Object.fromEntries(words.slice(0, SLOTS.length).map((word, at) => [SLOTS[at], word]))
}

/** `Findings: fix, ignore, later`, as a kind; undefined without a name and a word. */
export function parseKind(text: string): Kind | undefined {
  const match = /^\s*([^:=;]+?)\s*:\s*(.+)$/.exec(text)
  const verbs = parseWords(match?.[2] ?? '')
  if (match?.[1] === undefined || verbs.go === undefined) return undefined

  return { name: match[1], verbs }
}

/** `E=Events: keep, drop, later; M=Mods: build, skip, later`, by letter. */
export function parseOtherKinds(text: string): Record<string, Kind> {
  const kinds: Record<string, Kind> = {}
  for (const entry of text.split(';')) {
    const match = /^\s*([A-Za-z]{1,3})\s*=\s*(.+)$/.exec(entry)
    const kind = parseKind(match?.[2] ?? '')
    if (match?.[1] !== undefined && kind !== undefined) kinds[match[1].toUpperCase()] = kind
  }

  return kinds
}

/** The kinds from the settings, each setting left empty or unreadable taking its default. */
export function buildKinds(settings: {
  builtIn?: Partial<Record<keyof typeof KIND_DEFAULTS, string>>
  other?: string
  otherAnswers?: string
}): Kinds {
  const byPrefix: Record<string, Kind> = parseOtherKinds(settings.other ?? '')
  for (const [prefix, fallback] of Object.entries(KIND_DEFAULTS)) {
    const set = settings.builtIn?.[prefix as keyof typeof KIND_DEFAULTS]
    byPrefix[prefix] = parseKind(set ?? '') ?? (parseKind(fallback) as Kind)
  }
  const otherVerbs = parseWords(settings.otherAnswers ?? '')

  return { byPrefix, otherVerbs: otherVerbs.go === undefined ? parseWords(OTHER_ANSWERS_DEFAULT) : otherVerbs }
}

export const DEFAULT_KINDS = buildKinds({})

/** The quick answers a code of `prefix` takes, in slot order: `[['go', 'fix'], ...]`. */
export function verbsFor(prefix: string, kinds: Kinds = DEFAULT_KINDS): [Slot, string][] {
  const verbs = kinds.byPrefix[prefix]?.verbs ?? kinds.otherVerbs

  return SLOTS.flatMap(slot => {
    const word = verbs[slot]

    return word === undefined ? [] : [[slot, word] as [Slot, string]]
  })
}

/** The slot a stored answer fills for a code of `prefix`, or undefined for typed text. */
export function slotOf(prefix: string, answer: string, kinds: Kinds = DEFAULT_KINDS): Slot | undefined {
  return verbsFor(prefix, kinds).find(([, word]) => word === answer)?.[0]
}

/**
 * The prompt draft with one line answering `code`: `A2: do`, or `A2: ` and
 * typed text. A line already answering it is replaced in place; an empty
 * answer removes it.
 */
export function stageAnswer(draft: string, code: string, answer: string): string {
  const existing = new RegExp(`^[ \\t]*${code}:.*(\\n|$)`, 'im')
  const text = answer.trim()
  if (text === '') return draft.replace(existing, '').replace(/\n+$/, '')
  const line = `${code}: ${text}`
  if (existing.test(draft)) return draft.replace(new RegExp(`^[ \\t]*${code}:.*$`, 'im'), line)
  const kept = draft.replace(/\s+$/, '')

  return kept === '' ? line : `${kept}\n${line}`
}

/** The answers a prompt's lines give known codes, by code; `f2: Fix` answers F2 with `fix`. */
export function readAnswers(text: string, list: readonly Ref[], kinds: Kinds = DEFAULT_KINDS): Record<string, string> {
  const prefixOf = new Map(list.map(ref => [ref.code, ref.prefix]))
  const answers: Record<string, string> = {}
  for (const [, code = '', answer = ''] of text.matchAll(ANSWER_LINE)) {
    const upper = code.toUpperCase()
    const prefix = prefixOf.get(upper)
    if (prefix === undefined) continue
    const word = answer.toLowerCase()
    answers[upper] = slotOf(prefix, word, kinds) === undefined ? answer : word
  }

  return answers
}

/** Whether two answer sets hold the same answers, whatever their order. */
export function sameAnswers(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)

  return keys.length === Object.keys(b).length && keys.every(code => a[code] === b[code])
}

/** The refs whose code, text or group letters hold every word of `query`, any case. */
export function search(list: readonly Ref[], query: string, groupName: (prefix: string) => string): Ref[] {
  const words = query.toLowerCase().split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return [...list]

  return list.filter(ref => {
    const haystack = `${ref.code} ${ref.text} ${groupName(ref.prefix)}`.toLowerCase()

    return words.every(word => haystack.includes(word))
  })
}
