import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Answer, Ref } from '../types'
import {
  cited,
  contextBlock,
  group,
  inUse,
  merge,
  parse,
  readAnswers,
  sameAnswers,
  search,
  stageAnswer,
} from './codes'

const PANE = 'refs'
const codes = atom({ plugin: 'refs', key: 'codes' } as const, [])
const staged = atom({ plugin: 'refs', key: 'staged' } as const, {})
const sent = atom({ plugin: 'refs', key: 'sent' } as const, {})
const asides = atom({ plugin: 'refs', key: 'asides' } as const, [])
const query = atom({ plugin: 'refs', key: 'query' } as const, '')

const ANSWERS: readonly Answer[] = ['yes', 'no', 'defer']
const ANSWER_STYLE: Record<Answer, { glyph: string; color: string }> = {
  yes: { glyph: '✓', color: 'green' },
  no: { glyph: '✗', color: 'red' },
  defer: { glyph: '⋯', color: 'yellow' },
}

// The CLAUDE.md letters get a name and a color; any other letters show as written.
const GROUP_STYLE: Record<string, { name: string; color: string }> = {
  F: { name: 'Findings', color: 'cyan' },
  D: { name: 'Decisions', color: 'magenta' },
  O: { name: 'Options', color: 'blue' },
  R: { name: 'Risks', color: 'red' },
  Q: { name: 'Questions', color: 'yellow' },
  A: { name: 'Actions', color: 'green' },
}

const groupName = (prefix: string) => GROUP_STYLE[prefix]?.name ?? prefix

// Two presses on one code this close together are a double-click.
const DOUBLE_PRESS_MS = 400
// How often the pane checks the prompt draft, for surfaces whose edits raise no prompt.edit.
const DRAFT_CHECK_MS = 1000

// The transcript row each code was first drawn in, learned as replies draw:
// what a double-click scrolls to. The module's own, so a reload starts it over.
const sources = new Map<string, string>()
let lastPress: { code: string; at: number } | undefined

// Staged answers follow the draft: delete `A2: yes` and A2's mark goes with it.
async function syncStaged($: EngineInterface, draft: string): Promise<void> {
  const answers = readAnswers(draft, await read($, codes))
  if (!sameAnswers(answers, await read($, staged))) await update($, staged, () => answers)
}

async function jumpTo($: EngineInterface, ref: Ref): Promise<void> {
  const requestId = sources.get(ref.code)
  let reason: string | undefined
  if (requestId === undefined) {
    reason = 'its reply has not been drawn since the mod loaded'
  } else {
    try {
      reason = (await $.ui.scroll({ to: { requestId }, block: 'start' })).deny
    } catch (error) {
      reason = String(error)
    }
  }
  if (reason !== undefined) $.ui.toast(`Can't jump to ${ref.code}: ${reason}`)
}

// One press inserts the code at the cursor; a second within DOUBLE_PRESS_MS jumps
// to its reply instead. The insert waits out that window to know which it is.
async function pressCode($: EngineInterface, ref: Ref): Promise<void> {
  const at = await $.clock.now()
  if (lastPress?.code === ref.code && at - lastPress.at < DOUBLE_PRESS_MS) {
    lastPress = undefined

    return jumpTo($, ref)
  }
  const press = { code: ref.code, at }
  lastPress = press
  await $.clock.sleep(DOUBLE_PRESS_MS)
  if (lastPress !== press) return
  lastPress = undefined
  await $.prompt.fill({ text: `${ref.code} `, mode: 'insert' })
}

async function answerRef($: EngineInterface, ref: Ref, answer: Answer): Promise<void> {
  const draft = stageAnswer((await $.prompt.read()).text, ref.code, answer)
  await $.prompt.fill({ text: draft, mode: 'replace' })
  await syncStaged($, draft)
}

// btw: a side question over this conversation (`$.model.fork`), answered in the
// pane on every surface and never added to the conversation. Pressed again, it hides.
async function toggleAside($: EngineInterface, ref: Ref): Promise<void> {
  if ((await read($, asides)).some(aside => aside.code === ref.code)) {
    await update($, asides, list => list.filter(aside => aside.code !== ref.code))

    return
  }
  await update($, asides, list => [...list, { code: ref.code, status: 'asking' as const, text: '' }])
  // The fork can outlast a press's time budget, so it runs on a timer of its own.
  $.clock.after(0, async () => {
    const reply = await $.model.fork({
      prompt: `Side question, outside the main thread: explain ${ref.code} ("${ref.text}") in more depth. Answer in a few short paragraphs.`,
    })
    const answer = reply.isAnswered
      ? { status: 'answered' as const, text: reply.text }
      : { status: 'failed' as const, text: `No answer: ${reply.reason}.` }
    await update($, asides, list => list.map(aside => (aside.code === ref.code ? { ...aside, ...answer } : aside)))
  })
}

async function clearAll($: EngineInterface): Promise<void> {
  await update($, query, () => '')
  await update($, codes, () => [])
  await update($, staged, () => ({}))
  await update($, sent, () => ({}))
  await update($, asides, () => [])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'refs',
      description: 'Show the reference codes (F1, D2, A3) of this conversation; /refs clear empties the list',
    })

    // A resumed session's earlier replies hold codes the list has not seen.
    const messages = await $.session.messages()
    const found = messages.filter(m => m.role === 'assistant').flatMap(m => parse(m.text))
    await update($, codes, list => merge(list, found))

    $.clock.every(DRAFT_CHECK_MS, async () => {
      if ((await read($, codes)).length > 0) await syncStaged($, (await $.prompt.read()).text)
    })

    return next(e)
  })

  // Subagent turns define codes for their caller, not for you.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const found = parse(e.answer)
      await update($, codes, list => merge(list, found))
    }

    return done
  })

  // /clear ends the conversation the codes belong to.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await clearAll($)

    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await syncStaged($, box.text)

    return box
  })

  // The model gets the codes in use and the definitions of the ones the prompt
  // cites, as hidden context: they survive compaction of the replies that made them.
  // Answers the prompt carries move from staged to sent.
  on('prompt.submit', async ($, e, next) => {
    const list = await read($, codes)
    if (list.length === 0) return next(e)
    const answers = readAnswers(e.text, list)
    if (Object.keys(answers).length > 0) await update($, sent, before => ({ ...before, ...answers }))
    const note = contextBlock(list, cited(e.text, list))

    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('command.run', { command: 'refs' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'clear') {
      await clearAll($)

      return { text: 'Reference codes cleared.' }
    }
    // /refs toggles: a pane in view closes, one hidden behind another's tab or closed opens.
    const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
    if (isShown) {
      await $.ui.close({ id: PANE })

      return { text: 'Refs pane closed.' }
    }
    await $.ui.open({ id: PANE, title: 'Refs', closeOnEscape: true })
    const list = await read($, codes)

    return { text: `Refs pane opened: ${list.length} codes.` }
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    for (const { code } of parse(e.props.text)) {
      if (!sources.has(code)) sources.set(code, e.requestId)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = elements
    // Mobile draws no Input: the pane there lists every code.
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, codes)
    const inDraft = await read($, staged)
    const answered = await read($, sent)
    const open = await read($, asides)
    const searched = await read($, query)

    if (list.length === 0) {
      return <Text dimColor>No reference codes yet. They appear here as Claude defines them.</Text>
    }

    const shownRefs = search(list, searched, groupName)
    const stagedCount = Object.keys(inDraft).length
    const sentCount = Object.keys(answered).length
    const setQuery = (value: string) => update($, query, () => value)

    return (
      <Box flexDirection="column" gap={1}>
        {Input !== undefined && (
          <Input
            key="search"
            label="⌕ "
            placeholder="Search codes, text or a group (findings, actions)"
            value={searched}
            submitLabel="filter"
            onInput={setQuery}
            onSubmit={setQuery}
          />
        )}
        <Box flexDirection="row" gap={1}>
          <Text bold>
            {shownRefs.length === list.length ? `${list.length} codes` : `${shownRefs.length} of ${list.length} codes`}
          </Text>
          {stagedCount > 0 && <Text color="cyan">· {stagedCount} in your draft</Text>}
          {sentCount > 0 && <Text dimColor>· {sentCount} answered</Text>}
        </Box>
        {shownRefs.length === 0 && <Text dimColor>No codes match "{searched}".</Text>}

        {group(shownRefs).map(({ prefix, refs }) => {
          const style = GROUP_STYLE[prefix] ?? { name: prefix, color: 'white' }

          return (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text bold color={style.color}>
                  {style.name}
                </Text>
                <Text dimColor>{inUse(refs)}</Text>
              </Box>

              {/* Each code: a bar in its group's color, its mark (a draft answer
                  bright, a sent one dim, else a bullet), the code, its text
                  wrapping under itself, then its answer row and any btw answer. */}
              {refs.map(ref => {
                const draftAnswer = inDraft[ref.code]
                const sentAnswer = answered[ref.code]
                const shown = draftAnswer ?? sentAnswer
                const mark = shown === undefined ? undefined : ANSWER_STYLE[shown]
                const aside = open.find(one => one.code === ref.code)

                return (
                  <Box flexDirection="column" marginTop={1}>
                    <Box key={`row:${ref.code}`} flexDirection="row" gap={1}>
                      <Text color={style.color}>▍</Text>
                      <Text color={mark?.color} dimColor={draftAnswer === undefined} bold={draftAnswer !== undefined}>
                        {mark?.glyph ?? '•'}
                      </Text>
                      <Button
                        key={`code:${ref.code}`}
                        label={ref.code}
                        plain
                        hover={{ color: style.color, bold: true }}
                        onPress={() => pressCode($, ref)}
                      />
                      <Box flexGrow={1} flexShrink={1}>
                        <Text wrap="wrap" dimColor={sentAnswer !== undefined && draftAnswer === undefined}>
                          {ref.text}
                        </Text>
                      </Box>
                    </Box>

                    <Box flexDirection="row" gap={2} marginLeft={4}>
                      {ANSWERS.map(answer => (
                        <Box key={`${answer}-box:${ref.code}`} flexDirection="row">
                          <Text color={ANSWER_STYLE[answer].color} dimColor={draftAnswer !== answer}>
                            {draftAnswer === answer ? '● ' : '○ '}
                          </Text>
                          <Button
                            key={`${answer}:${ref.code}`}
                            label={answer}
                            plain
                            dimColor={draftAnswer !== answer}
                            hover={{ color: ANSWER_STYLE[answer].color, bold: true }}
                            onPress={() => answerRef($, ref, answer)}
                          />
                        </Box>
                      ))}
                      <Box key={`btw-box:${ref.code}`} flexDirection="row">
                        <Text color="magenta" dimColor={aside === undefined}>
                          {aside === undefined ? '○ ' : '● '}
                        </Text>
                        <Button
                          key={`btw:${ref.code}`}
                          label="btw"
                          plain
                          dimColor={aside === undefined}
                          hover={{ color: 'magenta', bold: true }}
                          onPress={() => toggleAside($, ref)}
                        />
                      </Box>
                    </Box>

                    {aside !== undefined && (
                      <Box
                        flexDirection="column"
                        marginLeft={4}
                        marginTop={1}
                        paddingX={1}
                        borderStyle="round"
                        borderColor="magenta"
                      >
                        <Text color="magenta" bold>
                          btw · {ref.code}
                        </Text>
                        {aside.status === 'asking' ? (
                          <Text dimColor>Asking…</Text>
                        ) : (
                          <Markdown text={aside.text.slice(0, 10000)} dimColor={aside.status === 'failed'} />
                        )}
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>
          )
        })}

        <Text dimColor>
          Click a code to insert it, double-click to jump to its reply. yes, no and defer add a line to your
          prompt; delete the line to undo. btw asks about the code on the side, outside the conversation.
        </Text>
      </Box>
    )
  })
}
