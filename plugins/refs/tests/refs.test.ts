import { expect, test } from 'claude-code/testing'

import { cited, contextBlock, inUse, parse } from '../hooks/codes'

const REPLY = [
  'Three findings.',
  '',
  '- **F1 Stale cache:** the loader reads before the write lands.',
  '- **F2** missing index on users.email',
  '1. F3: Retry loop never backs off',
  '### D1',
  'Use SQLite.',
  '| A1 | Delete legacy-config.json |',
  '- S3 bucket is public',
  'F1 and F2 share a cause.',
  '```',
  'A9: inside a fence',
  '```',
].join('\n')

test('parse keeps defined codes and skips prose and fences', async () => {
  const refs = parse(REPLY)

  expect(refs.map(ref => ref.code)).toEqual(['F1', 'F2', 'F3', 'D1', 'A1'])
  expect(refs[0]?.text).toBe('Stale cache: the loader reads before the write lands.')
  expect(refs[1]?.text).toBe('missing index on users.email')
  expect(refs[2]?.text).toBe('Retry loop never backs off')
  expect(refs[3]?.text).toBe('Use SQLite.')
  expect(refs[4]?.text).toBe('Delete legacy-config.json')
})

test('cited matches any case and expands ranges', async () => {
  const list = parse(REPLY)

  expect(cited('do a1 and look at f1-f3', list).map(ref => ref.code)).toEqual(['A1', 'F1', 'F2', 'F3'])
  expect(cited('F2–3 then d1', list).map(ref => ref.code)).toEqual(['F2', 'F3', 'D1'])
  expect(cited('x9 and the s3 bucket', list)).toEqual([])
})

test('inUse compresses runs per letter', async () => {
  expect(inUse(parse(REPLY))).toBe('F1–F3, D1, A1')
  expect(contextBlock(parse(REPLY), [])).not.toContain('cited')
})

test('codes from a reply reach the model when a prompt cites them', async ($, on) => {
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))

  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const submitted = await $.prompt.submit({ text: 'do a1', wait: false, origin: { kind: 'composer' } })
  const note = submitted.context?.at(-1) ?? ''
  expect(note).toContain('F1–F3, D1, A1')
  expect(note).toContain('A1: Delete legacy-config.json')
  expect(note).not.toContain('F1: Stale cache')
})

test('a subagent turn defines no codes', async ($, on) => {
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))

  await $.turn.complete({
    answer: REPLY,
    durationMs: 1,
    isAborted: false,
    turnId: 't2',
    agentId: 'sub',
    reason: 'answer',
  })
  const submitted = await $.prompt.submit({ text: 'do a1', wait: false, origin: { kind: 'composer' } })

  expect(submitted.context ?? []).toEqual([])
})

test('the pane lists codes and a press inserts one', async ($, on) => {
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'refs',
      surface,
      component: 'Pane',
      requestId: 'refs',
      props: {
        title: 'Refs',
        isFocused: true,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: 'Delete legacy-config.json' })).toBeDefined()
    await ui.press({ key: 'insert:A1' })
    await ui.unmount()
  }

  expect(filled).toEqual(['A1 ', 'A1 '])
})
