# claude-mods

Mods for [Claude Code](https://claude.com/claude-code). A mod is a plugin of function hooks: TypeScript that runs inside Claude Code, changes how it behaves, and draws UI in the terminal or the desktop app's Code tab.

Requires Claude Code 2.1.289 or newer. The mod API is early access and may change between releases.

## Install

```sh
claude plugin marketplace add RafeSymonds/claude-mods
claude plugin install refs@claude-mods
claude plugin install latex@claude-mods
```

Restart Claude Code, or run `/reload-plugins` in a running session.

## Mods

### refs

Makes reference codes (`F1`, `D2`, `A3`, ...) something Claude Code tracks instead of text you scroll back for.

- `/refs` opens a pane listing every code Claude has defined, with its text. Press a code to insert it in the prompt.
- When your prompt cites codes, in any case (`a2`, `A2`, `a1-a3`), their definitions go to the model as hidden context. They still resolve after compaction removes the reply that defined them.
- Every prompt tells the model which codes are in use, so new items continue the numbering instead of reusing a code.
- `/refs clear` empties the list. `/clear` does too.

A code counts as defined when it opens a line in Claude's reply: `- **F1 Name:** text`, `1. D2: text`, `### A3`, or a table row `| R1 | text |`.

refs works best with a `CLAUDE.md` that asks Claude to label its findings, decisions, options and actions with codes:

```markdown
When presenting three or more findings, decisions, options, risks, questions,
or actions, assign every one a short code: F1 for findings, D1 for decisions,
O1 for options, R1 for risks, Q1 for questions, A1 for actions.
Preserve the same codes throughout the conversation.
```

### latex

Renders the math in Claude's replies, including your own LaTeX macros.

- **Desktop app:** it already draws LaTeX, but not macros from your header. latex expands them first (`\newcommand`, `\DeclareMathOperator`, `\DeclarePairedDelimiter`, `\def`), so `\skcenc_k(m)` draws as Enc.
- **Terminal:** math is drawn as Unicode: `k ← Gen`, `Pr[Encₖ(m) = c]`, `ℳ, 𝒦, 𝒞`, `{0,1}ⁿ`.
- Only the display changes. The model and `/copy` keep the LaTeX, and code blocks are left as written.
- Headers are found on their own: `.sty` files and `.tex` files named like `header` or `hdr`, up to two folders deep. Set `headers` in `/config` to name them yourself. `/latex` shows which files were read.

## Develop

Load a mod from your clone for one session, then check and test it:

```sh
claude --plugin-dir ./plugins/refs
claude plugin validate ./plugins/refs
claude plugin test ./plugins/refs
```

To run your clone as your installed copy, add it as a local marketplace. Edits then take effect on `/reload-plugins`:

```sh
claude plugin marketplace add ./
claude plugin install refs@claude-mods
```

## License

MIT
