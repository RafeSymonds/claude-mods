import { expect, test } from 'claude-code/testing'

import { escapeMarkdown, rewriteMath } from '../hooks/markdown'
import { expand, parseHeader } from '../hooks/macros'
import { toUnicode } from '../hooks/unicode'

// The definition forms of a course header (CSE 575's), comments and all.
const HEADER = String.raw`
\RequirePackage{amsmath,amsfonts,amssymb,amsthm,mathtools}
\let\C\relax
\newcommand{\Z}{\ensuremath{\mathbb{Z}}}
\newcommand{\Zp}{\ensuremath{\Z_p}}
\newcommand{\Zps}{\ensuremath{\Z_p^*}}
\newcommand{\bit}{\ensuremath{\set{0,1}}} % bits
\DeclareMathOperator{\negl}{negl}
\DeclareMathOperator*{\E}{E}
\DeclarePairedDelimiter\abs{\lvert}{\rvert}
\DeclarePairedDelimiter\set{\{}{\}}
\newcommand{\algo}[1]{\ensuremath{\mathsf{#1}}}
\newcommand{\attacker}[1]{\ensuremath{\mathcal{#1}}}
\newcommand{\Adv}{\attacker{A}}
\newcommand{\skcgen}{\algo{Gen}}
\newcommand{\skcenc}{\algo{Enc}}
\newcommand{\msgspace}{\ensuremath{\mathcal{M}}}
\newcommand{\keyspace}{\ensuremath{\mathcal{K}}}
\newcommand{\ctspace}{\ensuremath{\mathcal{C}}}
\newcommand{\compind}{\ensuremath{\stackrel{c}{\approx}}}
\newcommand{\hwheader}{%
  \chead{\Large \textbf{Homework \hwnum}}
  \lhead{\small \textbf{Advanced\\Cryptography}}
}
\def\cbar{\bar{c}}
`

const MACROS = parseHeader(HEADER)
const terminal = (tex: string) => toUnicode(expand(tex, MACROS))

test('parseHeader reads every definition form', async () => {
  const names = MACROS.map(macro => macro.name)

  expect(names).toContain('Zps')
  expect(names).toContain('negl')
  expect(names).toContain('abs')
  expect(names).toContain('hwheader')
  expect(names).toContain('cbar')
  expect(MACROS.find(macro => macro.name === 'algo')?.args).toBe(1)
  expect(MACROS.find(macro => macro.name === 'E')?.body).toBe('\\operatorname*{E}')
})

test('expand resolves nested macros, arguments and paired delimiters', async () => {
  expect(expand('\\skcenc_k(m)', MACROS)).toBe('\\mathsf{Enc}_k(m)')
  expect(expand('\\Zps', MACROS)).toBe('\\mathbb{Z}_p^*')
  expect(expand('\\abs{x}', MACROS)).toBe('\\lvert x\\rvert')
  expect(expand('\\abs*{x}', MACROS)).toBe('\\left\\lvert x\\right\\rvert')
  expect(expand('\\bit^n', MACROS)).toBe('\\{0,1\\}^n')
  expect(expand('\\negl(n)', MACROS)).toBe('\\operatorname{negl}(n)')
})

test('toUnicode draws the notation of a security game', async () => {
  expect(terminal('\\msgspace, \\keyspace, \\ctspace')).toBe('ℳ, 𝒦, 𝒞')
  expect(terminal('k \\gets \\skcgen')).toBe('k ← Gen')
  expect(terminal('\\Pr[\\skcenc_k(m) = c]')).toBe('Pr[Encₖ(m) = c]')
  expect(terminal('\\bit^n')).toBe('{0,1}ⁿ')
  expect(terminal('m_0 \\oplus m_1')).toBe('m₀ ⊕ m₁')
  expect(terminal('\\frac{1}{2} + \\negl(n)')).toBe('1/2 + negl(n)')
  expect(terminal('\\frac{1}{\\abs{\\msgspace}}')).toBe('1/(|ℳ|)')
  expect(terminal('X \\compind Y')).toBe('X ≈ᶜ Y')
  expect(terminal('\\Adv^{\\skcenc}')).toBe('𝒜ᴱⁿᶜ')
  expect(terminal('\\cbar')).toBe('c̄')
  expect(terminal('\\Zps')).toBe('ℤₚ*')
})

test('rewriteMath leaves code, prices and shell variables alone', async () => {
  const mark = (s: string) => rewriteMath(s, region => `<${region.tex}>`)

  expect(mark('so $x \\in \\msgspace$ holds')).toBe('so <x \\in \\msgspace> holds')
  expect(mark('display:\n$$\na + b\n$$\nend')).toBe('display:\n<\na + b\n>\nend')
  expect(mark('costs $5 and $10 total')).toBe('costs $5 and $10 total')
  expect(mark('set $HOME/$USER first')).toBe('set $HOME/$USER first')
  expect(mark('use `$\\msgspace$` in the header')).toBe('use `$\\msgspace$` in the header')
  expect(mark('```latex\n$\\msgspace$\n```')).toBe('```latex\n$\\msgspace$\n```')
})

test('escapeMarkdown keeps scripts and bars literal', async () => {
  expect(escapeMarkdown('a_(i) * |b|')).toBe('a\\_(i) \\* \\|b\\|')
})

const REPLY = 'For $k \\gets \\skcgen$, each $m \\in \\msgspace$ has\n\n$$\\Pr[\\skcenc_k(m) = c] = \\frac{1}{\\abs{\\keyspace}}$$\n\n```latex\n\\skcenc_k(m)\n```'

const HEADER_FILES = { '/course/hw1/header.tex': HEADER }

test('the terminal draws math as Unicode and the desktop gets expanded LaTeX', async ($, on) => {
  on('fs.list', ($, e) => ({
    value:
      e.path === '/course'
        ? [{ name: 'hw1', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }]
        : [{ name: 'header.tex', kind: 'file' as const, size: HEADER.length, mtimeMs: 0, isLink: false }],
  }))
  on('fs.read', ($, e) => ({ value: HEADER_FILES[e.path as keyof typeof HEADER_FILES] ?? '' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    const props = e.props as { text: string }

    return <Markdown key="reply" text={props.text} />
  })

  await $.session.start({ cwd: '/course', surface: 'terminal', isInteractive: true })

  const shown: Record<string, string> = {}
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'latex',
      surface,
      component: 'AssistantMessage',
      props: { text: REPLY, isFirstOfReply: true },
    })
    shown[surface] = (await ui.find({ key: 'reply' }))?.text ?? ''
    await ui.unmount()
  }

  expect(shown.terminal).toContain('For k ← Gen, each m ∈ ℳ has')
  expect(shown.terminal).toContain('Pr\\[Encₖ(m) = c\\] = 1/(\\|𝒦\\|)')
  expect(shown.terminal).toContain('```latex\n\\skcenc_k(m)\n```')
  expect(shown.desktop).toContain('$k \\gets \\mathsf{Gen}$')
  expect(shown.desktop).toContain('$$\\Pr[\\mathsf{Enc}_k(m) = c] = \\frac{1}{\\lvert \\mathcal{K}\\rvert}$$')
})
