import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Answer, Ref } from '../types'
import { cited, contextBlock, group, merge, parse, stageAnswer } from './codes'

const PANE = 'refs'
const codes = atom({ plugin: 'refs', key: 'codes' } as const, [])

const ANSWERS: readonly Answer[] = ['yes', 'no', 'defer', 'other']
const MARKS: Record<Answer, { glyph: string; color: string }> = {
  yes: { glyph: '✓', color: 'green' },
  no: { glyph: '✗', color: 'red' },
  defer: { glyph: '⋯', color: 'yellow' },
  other: { glyph: '✎', color: 'blue' },
}

// Two presses on one code this close together are a double-click.
const DOUBLE_PRESS_MS = 400

// The transcript row each code was first drawn in, learned as replies draw:
// what a double-click scrolls to. The module's own, so a reload starts it over.
const sources = new Map<string, string>()
let lastPress: { code: string; at: number } | undefined

async function jumpTo($: EngineInterface, ref: Ref): Promise<void> {
  const requestId = sources.get(ref.code)
  const moved =
    requestId === undefined
      ? { deny: 'its reply has not been drawn since the mod loaded' }
      : await $.ui.scroll({ to: { requestId }, block: 'start' })
  if (moved.deny !== undefined) $.ui.toast(`Can't jump to ${ref.code}: ${moved.deny}`)
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
  const { text } = await $.prompt.read()
  await $.prompt.fill({ text: stageAnswer(text, ref.code, answer), mode: 'replace' })
  await update($, codes, list => list.map(one => (one.code === ref.code ? { ...one, answer } : one)))
}

// A side question through /btw, which answers without adding to the conversation.
async function askAside($: EngineInterface, ref: Ref): Promise<void> {
  try {
    await $.command.run({ command: 'btw', args: `Explain ${ref.code} in more depth: ${ref.text}` })
  } catch (error) {
    $.ui.toast(`/btw did not run: ${String(error)}`)
  }
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
    if (e.reason === 'clear') await update($, codes, () => [])

    return next(e)
  })

  // The model gets the codes in use and the definitions of the ones the prompt
  // cites, as hidden context: they survive compaction of the replies that made them.
  on('prompt.submit', async ($, e, next) => {
    const list = await read($, codes)
    if (list.length === 0) return next(e)
    const note = contextBlock(list, cited(e.text, list))

    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('command.run', { command: 'refs' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'clear') {
      await update($, codes, () => [])

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
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, codes)

    if (list.length === 0) {
      return <Text dimColor>No reference codes yet. They appear here as Claude defines them.</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        {group(list).map(({ refs }) => (
          <Box flexDirection="column">
            {/* Each code: its mark (a bullet until answered), the code, its text
                wrapping under itself, then a row of answers under the text. */}
            {refs.map(ref => {
              const mark = ref.answer === undefined ? undefined : MARKS[ref.answer]

              return (
                <Box flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Text color={mark?.color} dimColor={mark === undefined}>
                      {mark?.glyph ?? '•'}
                    </Text>
                    <Button key={`code:${ref.code}`} label={ref.code} plain onPress={() => pressCode($, ref)} />
                    <Box flexGrow={1} flexShrink={1}>
                      <Text wrap="wrap">{ref.text}</Text>
                    </Box>
                  </Box>
                  <Box flexDirection="row" gap={2} marginLeft={2}>
                    {ANSWERS.map(answer => (
                      <Button
                        key={`${answer}:${ref.code}`}
                        label={answer}
                        plain
                        dimColor
                        onPress={() => answerRef($, ref, answer)}
                      />
                    ))}
                    <Button key={`btw:${ref.code}`} label="btw" plain dimColor onPress={() => askAside($, ref)} />
                  </Box>
                </Box>
              )
            })}
          </Box>
        ))}
        <Text dimColor>
          Click a code to insert it, double-click to jump to its reply. Answers stage a line in your prompt;
          send them with Enter. btw asks about the code on the side.
        </Text>
      </Box>
    )
  })
}
