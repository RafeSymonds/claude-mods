import { readArg, readOption } from './macros'

// Math as plain Unicode for a surface that draws no math (the terminal).
// Covers the notation proofs use: fonts, scripts, fractions, accents, the
// common symbols. A command it does not know is kept as written.

type Cursor = { src: string; at: number }

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'

function alphabet(letters: string, glyphs: string): Map<string, string> {
  const chars = [...glyphs]

  return new Map([...letters].map((letter, i) => [letter, chars[i] ?? letter]))
}

const SCRIPT = alphabet(
  UPPER + LOWER,
  '𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵𝒶𝒷𝒸𝒹ℯ𝒻ℊ𝒽𝒾𝒿𝓀𝓁𝓂𝓃ℴ𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏',
)
const DOUBLE = alphabet(UPPER + '01', '𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ𝟘𝟙')
const SUPER = alphabet(
  '0123456789+-=()abcdefghijklmnoprstuvwxyzABDEGHIJKLMNOPRTUVW*',
  '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ*',
)
const SUB = alphabet('0123456789+-=()aehijklmnoprstuvx', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ')

// Drawn with a space each side: relations, arrows and binary operators.
const SPACED: Record<string, string> = {
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡',
  sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫', in: '∈', notin: '∉',
  ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', setminus: '∖',
  mid: '|', parallel: '∥', perp: '⊥', models: '⊨', vdash: '⊢', to: '→', rightarrow: '→',
  leftarrow: '←', gets: '←', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  leftrightarrow: '↔', iff: '⟺', implies: '⟹', impliedby: '⟸', mapsto: '↦',
  longrightarrow: '⟶', longleftarrow: '⟵', times: '×', cdot: '·', pm: '±', mp: '∓',
  div: '÷', ast: '∗', star: '⋆', circ: '∘', bullet: '•', oplus: '⊕', otimes: '⊗',
  odot: '⊙', wedge: '∧', land: '∧', vee: '∨', lor: '∨', cap: '∩', cup: '∪',
  coloneqq: '≔', coloneq: '≔', eqqcolon: '≕', triangleq: '≜', bmod: 'mod',
}

const SYMBOL: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ',
  Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', neg: '¬', lnot: '¬', sum: '∑', prod: '∏', coprod: '∐',
  bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', int: '∫', oint: '∮', partial: '∂', nabla: '∇',
  infty: '∞', forall: '∀', exists: '∃', nexists: '∄', emptyset: '∅', varnothing: '∅',
  top: '⊤', bot: '⊥', angle: '∠', triangle: '△', Box: '□', square: '□', blacksquare: '■',
  diamond: '⋄', aleph: 'ℵ', ell: 'ℓ', hbar: 'ℏ', wp: '℘', prime: '′', backslash: '∖',
  langle: '⟨', rangle: '⟩', lvert: '|', rvert: '|', vert: '|', lVert: '‖', rVert: '‖',
  Vert: '‖', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', llbracket: '⟦',
  rrbracket: '⟧', ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  checkmark: '✓', dagger: '†', ddagger: '‡', qed: '∎', S: '§', uparrow: '↑',
  downarrow: '↓', dollar: '$', colon: ':',
  // Spacing: thin and wide spaces, a negative one dropped.
  quad: '  ', qquad: '    ', enspace: ' ',
}

// Written as their names, upright.
const NAMED = new Set([
  'log', 'ln', 'lg', 'exp', 'sin', 'cos', 'tan', 'min', 'max', 'sup', 'inf', 'lim',
  'liminf', 'limsup', 'det', 'gcd', 'lcm', 'Pr', 'deg', 'dim', 'ker', 'arg', 'mod',
])

// Fonts and wrappers whose argument is drawn as plain letters.
const PLAIN = new Set([
  'mathsf', 'mathrm', 'mathit', 'mathbf', 'mathtt', 'mathfrak', 'boldsymbol', 'text',
  'textrm', 'textsf', 'texttt', 'textit', 'textbf', 'textup', 'mbox', 'operatorname',
  'emph', 'mathnormal',
])

// Dropped with no output: sizing, styles, labels.
const DROPPED = new Set([
  'left', 'right', 'middle', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr',
  'biggl', 'biggr', 'Biggl', 'Biggr', 'textstyle', 'scriptstyle', 'limits', 'nolimits',
  'nonumber', 'notag', 'relax', 'displaystyle', 'centering', 'noindent',
])

// Combining marks an accent command puts on each character of its argument.
const ACCENT: Record<string, string> = {
  bar: '\u0304', overline: '\u0305', hat: '\u0302', widehat: '\u0302', tilde: '\u0303',
  widetilde: '\u0303', vec: '\u20d7', dot: '\u0307', ddot: '\u0308', underline: '\u0332',
}

function mapAll(text: string, table: Map<string, string>): string | undefined {
  let out = ''
  for (const ch of text) {
    const glyph = table.get(ch)
    if (glyph === undefined) return undefined
    out += glyph
  }

  return out
}

function accent(text: string, mark: string): string {
  return [...text].map(ch => (ch === ' ' ? ch : ch + mark)).join('')
}

/** A script's text: mapped glyphs when every character has one, else `^(x)` / `_(x)`. */
function script(text: string, table: Map<string, string>, sign: '^' | '_'): string {
  const compact = text.replace(/\s+/g, '')
  const mapped = mapAll(compact, table)
  if (mapped !== undefined) return mapped

  return [...compact].length === 1 ? `${sign}${compact}` : `${sign}(${compact})`
}

function wrap(text: string): string {
  return /^[\p{L}\p{N}]+$/u.test(text) || /^\(.*\)$/.test(text) ? text : `(${text})`
}

function convert(c: Cursor, isDisplay: boolean): string {
  let out = ''

  while (c.at < c.src.length) {
    const ch = c.src[c.at] ?? ''

    if (ch === '{') {
      out += convert({ src: readArg(c), at: 0 }, isDisplay)
      continue
    }
    if (ch === '^' || ch === '_') {
      c.at++
      const inner = convert({ src: readArg(c), at: 0 }, isDisplay)
      out += ch === '^' ? script(inner, SUPER, '^') : script(inner, SUB, '_')
      continue
    }
    if (ch === '&') {
      out += ' '
      c.at++
      continue
    }
    if (ch === '~') {
      out += ' '
      c.at++
      continue
    }
    if (ch !== '\\') {
      // Relations get room either side, however tightly the source wrote them.
      out += '=<>'.includes(ch) ? ` ${ch} ` : ch
      c.at++
      continue
    }

    const word = /^\\([A-Za-z]+)\*?/.exec(c.src.slice(c.at))
    if (word === null) {
      // A control symbol: `\\` breaks a line, `\,` and kin are spaces, `\{` is `{`.
      const symbol = c.src[c.at + 1] ?? ''
      c.at += 2
      if (symbol === '\\') out += isDisplay ? '\n' : '; '
      else if (',;: '.includes(symbol)) out += ' '
      else if (symbol === '!') out += ''
      else if (symbol === '|') out += '‖'
      else out += symbol
      continue
    }

    c.at += word[0].length
    const name = word[1] ?? ''
    // TeX skips the spaces after a control word; they end its name.
    while (c.src[c.at] === ' ') c.at++
    out += command(name, c, isDisplay)
  }

  return out
}

function command(name: string, c: Cursor, isDisplay: boolean): string {
  const arg = () => convert({ src: readArg(c), at: 0 }, isDisplay)

  if (name === 'mathcal' || name === 'mathscr') {
    const text = arg()

    return mapAll(text, SCRIPT) ?? text
  }
  if (name === 'mathbb' || name === 'mathbbm') {
    const text = arg()

    return mapAll(text, DOUBLE) ?? text
  }
  if (PLAIN.has(name)) return arg()
  if (DROPPED.has(name)) {
    if (name === 'left' || name === 'right') {
      // `\left.` draws no delimiter.
      if (c.src[c.at] === '.') c.at++
    }

    return ''
  }
  if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
    const top = arg()

    return `${wrap(top)}/${wrap(arg())}`
  }
  if (name === 'binom') {
    const top = arg()

    return `C(${top}, ${arg()})`
  }
  if (name === 'sqrt') {
    const root = readOption(c)
    const body = arg()

    return `${root === undefined ? '' : script(root, SUPER, '^')}√${wrap(body)}`
  }
  if (name === 'stackrel' || name === 'overset') {
    const over = arg()
    const base = arg().trim()

    return ` ${base}${script(over, SUPER, '^')} `
  }
  if (name === 'underset') {
    const under = arg()
    const base = arg().trim()

    return ` ${base}${script(under, SUB, '_')} `
  }
  if (name === 'xleftarrow' || name === 'xrightarrow') {
    const over = arg()
    const arrow = name === 'xleftarrow' ? '←' : '→'

    return ` ${arrow}${over === '' ? '' : script(over, SUPER, '^')} `
  }
  if (name === 'pmod') return ` (mod ${arg()})`
  if (name === 'substack') return arg().replace(/\n|; /g, ', ')
  // `\not` strikes the symbol after it, whatever spacing that symbol carries.
  if (name === 'not') return convert(c, isDisplay).replace(/^\s*(\S)/u, ' $1\u0338')
  if (name === 'boxed') return `[${arg()}]`
  if (name === 'underbrace' || name === 'overbrace' || name === 'phantom') return arg()
  if (name === 'color') {
    arg()

    return ''
  }
  if (name === 'textcolor') {
    arg()

    return arg()
  }
  if (name === 'label' || name === 'tag' || name === 'hspace' || name === 'vspace') {
    arg()

    return ''
  }
  if (name === 'begin' || name === 'end') {
    const env = readArg(c)
    if (name === 'begin' && /^(array|tabular)/.test(env)) readArg(c)
    if (env === 'cases') return name === 'begin' ? '{ ' : ''

    return isDisplay ? '\n' : ' '
  }
  if (name in ACCENT) return accent(arg(), ACCENT[name] ?? '')
  if (NAMED.has(name)) return name
  if (name in SPACED) return ` ${SPACED[name]} `
  if (name in SYMBOL) return SYMBOL[name] ?? ''

  return `\\${name}`
}

/** `tex` (one math region's inside, macros expanded) as Unicode text. */
export function toUnicode(tex: string, isDisplay = false): string {
  return convert({ src: tex, at: 0 }, isDisplay)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,;)\]}])/g, '$1')
    .replace(/([([{]) +/g, '$1')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim()
}
