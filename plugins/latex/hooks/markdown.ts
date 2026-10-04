// Finds the math in a reply's markdown and rewrites it, leaving code alone:
// fenced blocks and inline code spans are LaTeX you may want to copy as is.

/** One math region: its inside, whether it is display math, and its delimiters. */
export type MathRegion = { tex: string; isDisplay: boolean; open: string; close: string }

const FENCE = /^\s*(```|~~~)/

// Display math first, so `$$` is never read as two inline dollars.
const MATH =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<!\s)\$(?![\d$])/g

// `$...$` in prose is math only when it reads as math: a command, a script or
// brace, an operator, or a short symbol (`$x$`, `$n$`). `$HOME/$USER` is not.
function isMathLike(tex: string): boolean {
  return /[\\^_{}=<>+]/.test(tex) || /^[A-Za-z0-9]{1,3}$/.test(tex.trim())
}

function rewriteProse(text: string, render: (region: MathRegion) => string): string {
  return text.replace(MATH, (whole, d1?: string, d2?: string, i1?: string, i2?: string) => {
    if (d1 !== undefined) return render({ tex: d1, isDisplay: true, open: '$$', close: '$$' })
    if (d2 !== undefined) return render({ tex: d2, isDisplay: true, open: '\\[', close: '\\]' })
    if (i1 !== undefined) return render({ tex: i1, isDisplay: false, open: '\\(', close: '\\)' })
    if (i2 !== undefined && isMathLike(i2)) {
      return render({ tex: i2, isDisplay: false, open: '$', close: '$' })
    }

    return whole
  })
}

/** `markdown` with each math region outside code replaced by `render`'s answer. */
export function rewriteMath(markdown: string, render: (region: MathRegion) => string): string {
  const out: string[] = []
  let prose: string[] = []
  let isInFence = false
  const flush = () => {
    if (prose.length > 0) out.push(rewriteSpans(prose.join('\n'), render))
    prose = []
  }

  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      if (!isInFence) flush()
      isInFence = !isInFence
      out.push(line)
      continue
    }
    if (isInFence) out.push(line)
    else prose.push(line)
  }
  flush()

  return out.join('\n')
}

// Inline code spans pass through; the text between them is rewritten.
function rewriteSpans(text: string, render: (region: MathRegion) => string): string {
  return text
    .split(/(`+[^`]*?`+)/)
    .map((piece, i) => (i % 2 === 1 ? piece : rewriteProse(piece, render)))
    .join('')
}

/** Escapes what markdown would read as markup in converted math: `a_1 * b_2` stays literal. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]|<>#])/g, '\\$1')
}
