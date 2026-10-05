import { expect, mock, test } from 'claude-code/testing'

import { cited, contextBlock, inUse, merge, parse, readAnswers, search, stageAnswer } from '../hooks/codes'

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

test('merge keeps one ref per code when several replies define it', async () => {
  const twice = merge([], [...parse(REPLY), ...parse(REPLY)])

  expect(twice.map(ref => ref.code)).toEqual(['F1', 'F2', 'F3', 'D1', 'A1'])
  expect(inUse(twice)).toBe('F1\u2013F3, D1, A1')
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

test('/refs opens the pane, asks for the keyboard once it has run, and closes it when shown', async ($, on) => {
  const clock = mock.clock(on)
  on('command.run', () => ({ text: 'core' }))
  const shown = new Set<string>()
  const focused = new Set<string>()
  on('ui.panes', () => ({
    value: [...shown].map(id => ({ id, title: id, isShown: true, isFocused: focused.has(id), isPlaced: true })),
  }))
  on('ui.open', ($, e) => {
    shown.add(e.id)
    if (e.focus === true) focused.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    shown.delete(e.id)

    return { value: undefined }
  })
  const run = () =>
    $.command.run({
      command: 'refs',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })

  expect((await run()).text).toContain('opened')
  expect(shown.has('refs')).toBe(true)
  expect(focused.has('refs')).toBe(false)
  await clock.advance(200)
  expect(focused.has('refs')).toBe(true)
  expect((await run()).text).toBe('Refs pane closed.')
  expect(shown.has('refs')).toBe(false)
})

test('readAnswers reads quick and typed answers for known codes, any case', async () => {
  const list = parse(REPLY)

  expect(readAnswers('a1: yes\nF2: Defer\nZ9: no\nF3: maybe later', list)).toEqual({
    A1: 'yes',
    F2: 'defer',
    F3: 'maybe later',
  })
})

test('search matches every word against code, text and group', async () => {
  const list = parse(REPLY)
  const name = (prefix: string) => ({ F: 'Findings', A: 'Actions' })[prefix] ?? prefix

  expect(search(list, 'a1', name).map(ref => ref.code)).toEqual(['A1'])
  expect(search(list, 'findings retry', name).map(ref => ref.code)).toEqual(['F3'])
  expect(search(list, '  ', name)).toHaveLength(5)
})

test('stageAnswer keeps one line per code', async () => {
  expect(stageAnswer('', 'A1', 'yes')).toBe('A1: yes')
  expect(stageAnswer('A1: yes', 'A2', 'defer')).toBe('A1: yes\nA2: defer')
  expect(stageAnswer('A1: yes\nA2: defer', 'A1', 'no')).toBe('A1: no\nA2: defer')
})

const PANE_PROPS = {
  title: 'Refs',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

test('the pane: vim keys, toggled answers, typed answers, btw questions, search', async ($, on) => {
  const clock = mock.clock(on)
  let draft = 'A1: no'
  const filled: string[] = []
  const toasts: string[] = []
  const completions: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [{ role: 'assistant' as const, text: REPLY, toolUses: [] }] }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    if (e.mode === 'replace') draft = e.text

    return { isFilled: true }
  })
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))

    return { value: undefined }
  })
  // No main thread to fork, as in a desktop session just opened: btw falls back to a completion.
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork', usage: {} } as never }))
  on('model.complete', ($, e) => {
    completions.push(e.prompt)

    return { value: { isAnswered: true, text: 'Because the loader reads stale config.', usage: {} } as never }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{(e.props as { text?: string }).text ?? ''}</Text>
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })

  const ui = await $.ui.mount({ plugin: 'refs', surface: 'terminal', component: 'Pane', requestId: 'refs', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'Delete legacy-config.json' })).toBeDefined()

  // A click on a code selects it and jumps to its reply; this reply was never drawn, so it says so.
  await ui.press({ key: 'code:A1' })
  expect(toasts.some(text => text.includes("Can't jump to A1"))).toBe(true)
  expect(filled).toEqual([])

  // j and k move the selection through the shown order (Findings, Decisions, Actions); p puts the code.
  await ui.press({ key: 'key:k' })
  await ui.press({ key: 'key:p' })
  expect(filled).toEqual(['D1 '])
  await ui.press({ key: 'key:j' })

  // y answers the selected code; y again takes it back.
  await ui.press({ key: 'key:y' })
  expect(draft).toBe('A1: yes')
  expect(await ui.find({ type: 'Text', text: '✓' })).toBeDefined()
  await ui.press({ key: 'key:y' })
  expect(draft).toBe('')
  expect(await ui.find({ type: 'Text', text: '✓' })).toBeUndefined()

  // Deleting an answer line from the draft clears its mark at the next draft check.
  await ui.press({ key: 'defer:F2' })
  expect(await ui.find({ type: 'Text', text: '⋯' })).toBeDefined()
  draft = ''
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: '⋯' })).toBeUndefined()

  // i opens the selected code's answer field; Enter puts the typed answer in the draft.
  await ui.press({ key: 'key:i' })
  await ui.input({ key: 'answer:A1', text: 'keep it, but behind a flag' })
  expect(draft).toBe('A1: keep it, but behind a flag')
  expect(await ui.find({ type: 'Text', text: '✎' })).toBeDefined()

  // The type button takes a typed answer back, as yes, no and defer do.
  await ui.press({ key: 'type:A1' })
  expect(draft).toBe('')
  expect(await ui.find({ type: 'Text', text: '✎' })).toBeUndefined()
  await ui.press({ key: 'type:A1' })
  await ui.input({ key: 'answer:A1', text: 'keep it, but behind a flag' })
  expect(draft).toBe('A1: keep it, but behind a flag')

  // b opens a question field; the answer shows in the pane.
  await ui.press({ key: 'btw:F2' })
  const asked = ui.input({ key: 'ask:F2', text: 'Which table needs it?' })
  await clock.advance(1)
  await asked
  await clock.advance(1)
  expect(completions[0]).toContain('Which table needs it?')
  expect(completions[0]).toContain('missing index on users.email')
  expect(await ui.find({ type: 'Markdown', text: /stale config/ })).toBeDefined()

  // z folds the selected code's group to its header; ▾ unfolds it.
  await ui.press({ key: 'code:A1' })
  await ui.press({ key: 'key:z' })
  expect(await ui.find({ key: 'fold:A' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Delete legacy-config.json' })).toBeUndefined()
  await ui.press({ key: 'fold:A' })
  expect(await ui.find({ type: 'Text', text: 'Delete legacy-config.json' })).toBeDefined()

  // Search narrows the list.
  await ui.input({ key: 'search', text: 'retry', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: '1 of 5 codes' })).toBeDefined()
  await ui.unmount()
})

test('the pane draws on every surface, with search where the surface has input', async ($, on) => {
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: REPLY, durationMs: 1, isAborted: false, turnId: 't4', reason: 'answer' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'refs', surface, component: 'Pane', requestId: 'refs', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Delete legacy-config.json' })).toBeDefined()
    expect(await ui.find({ key: 'btw:A1' })).toBeDefined()
    if (surface !== 'mobile') expect(await ui.find({ key: 'search' })).toBeDefined()
    await ui.unmount()
  }
})
