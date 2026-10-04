import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { cited, contextBlock, fresh, group, parse } from './codes'

const PANE = 'refs'
const codes = atom({ plugin: 'refs', key: 'codes' } as const, [])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'refs',
      description: 'Show the reference codes (F1, D2, A3) of this conversation; /refs clear empties the list',
    })

    // A resumed session's earlier replies hold codes the list has not seen.
    const messages = await $.session.messages()
    const found = messages.filter(m => m.role === 'assistant').flatMap(m => parse(m.text))
    await update($, codes, list => [...list, ...fresh(list, found)])

    return next(e)
  })

  // Subagent turns define codes for their caller, not for you.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const found = parse(e.answer)
      await update($, codes, list => [...list, ...fresh(list, found)])
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
    await $.ui.open({ id: PANE, title: 'Refs', closeOnEscape: true })
    const list = await read($, codes)

    return { text: `Refs pane opened: ${list.length} codes.` }
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
            {refs.map(ref => (
              <Box flexDirection="row" gap={1}>
                <Button
                  key={`insert:${ref.code}`}
                  label={ref.code}
                  plain
                  onPress={() => $.prompt.fill({ text: `${ref.code} `, mode: 'insert' })}
                />
                <Text wrap="truncate-end">{ref.text}</Text>
              </Box>
            ))}
          </Box>
        ))}
        <Text dimColor>Press a code to insert it in the prompt.</Text>
      </Box>
    )
  })
}
