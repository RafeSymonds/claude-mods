import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Macro } from '../types'
import { escapeMarkdown, rewriteMath } from './markdown'
import { expand, parseHeader } from './macros'
import { toUnicode } from './unicode'

const macros = atom({ plugin: 'latex', key: 'macros' } as const, [])
const sources = atom({ plugin: 'latex', key: 'sources' } as const, [])

// A header is a `.sty`, or a `.tex` named for one: `header.tex`, `guidehdr.tex`.
const HEADER = /(header|hdr)[^/]*\.tex$|\.sty$/i
const SKIPPED_DIR = /^(\.|node_modules$|build$|dist$|out$|Library$)/

// A session started in a large folder (a home directory) stops looking after this many listings.
const MAX_LISTINGS = 60

/** Header files in the project, two folders deep, relative to `root`. */
async function findHeaders(
  $: EngineInterface,
  root: string,
  dir = '',
  budget = { listings: MAX_LISTINGS },
): Promise<string[]> {
  if (budget.listings-- <= 0) return []
  const found: string[] = []
  const depth = dir === '' ? 0 : dir.split('/').length
  for (const entry of await $.fs.list(dir === '' ? root : `${root}/${dir}`)) {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.kind === 'file' && HEADER.test(entry.name)) found.push(path)
    if (entry.kind === 'dir' && depth < 2 && !SKIPPED_DIR.test(entry.name)) {
      found.push(...(await findHeaders($, root, path, budget)))
    }
  }

  return found.sort()
}

export const register: Register = (on, options) => {
  const configured = String(options.headers ?? '')
    .split(',')
    .map(path => path.trim())
    .filter(path => path !== '')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'latex',
      description: 'Show which header files the LaTeX macros were read from',
    })

    // Paths are the project's, relative to where the session started.
    const paths = configured.length > 0 ? configured : await findHeaders($, e.cwd)
    const read: string[] = []
    const all: Macro[] = []
    for (const path of paths) {
      try {
        all.push(...parseHeader(await $.fs.read(path.startsWith('/') ? path : `${e.cwd}/${path}`)))
        read.push(path)
      } catch {
        // An unreadable header is skipped; /latex lists the ones read.
      }
    }
    await update($, macros, () => all)
    await update($, sources, () => read)

    return next(e)
  })

  on('command.run', { command: 'latex' }, async $ => {
    const list = await read($, macros)
    const files = await read($, sources)

    return {
      text:
        files.length === 0
          ? 'No header found: math renders without custom macros. Set headers in /config to name one.'
          : `${list.length} macros from ${files.join(', ')}.`,
    }
  })

  // The desktop draws math itself and needs only the macros expanded; the
  // terminal draws none, so its math becomes Unicode. Only the drawing changes:
  // the model and /copy keep the reply's LaTeX.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const list = await read($, macros)
    const isTerminal = e.surface === 'terminal'
    const text = rewriteMath(e.props.text, ({ tex, isDisplay, open, close }) => {
      const expanded = expand(tex, list)
      if (!isTerminal) return `${open}${expanded}${close}`
      const unicode = escapeMarkdown(toUnicode(expanded, isDisplay))

      return isDisplay ? `\n\n${unicode.split('\n').join('  \n')}\n\n` : unicode
    })

    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })
}
