import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ref, Slot } from '../types'
import type { Kinds } from './codes'
import {
  buildKinds,
  cited,
  contextBlock,
  DEFAULT_KINDS,
  DEFERRED,
  group,
  inUse,
  merge,
  parse,
  readAnswers,
  sameAnswers,
  search,
  slotOf,
  stageAnswer,
  verbsFor,
} from './codes'

const PANE = 'refs'
const codes = atom({ plugin: 'refs', key: 'codes' } as const, [])
const staged = atom({ plugin: 'refs', key: 'staged' } as const, {})
const sent = atom({ plugin: 'refs', key: 'sent' } as const, {})
const asides = atom({ plugin: 'refs', key: 'asides' } as const, [])
const query = atom({ plugin: 'refs', key: 'query' } as const, '')
const selected = atom({ plugin: 'refs', key: 'selected' } as const, '')
const typing = atom({ plugin: 'refs', key: 'typing' } as const, '')
const asking = atom({ plugin: 'refs', key: 'asking' } as const, '')
const folded = atom({ plugin: 'refs', key: 'folded' } as const, [])
const turn = atom({ plugin: 'refs', key: 'turn' } as const, 0)
const parked = atom({ plugin: 'refs', key: 'parked' } as const, [])
const showDeferred = atom({ plugin: 'refs', key: 'showDeferred' } as const, false)

// A code's background by how many turns ago its reply came: this turn bright,
// then fading, then none.
const AGE_BACKGROUND = ['#1f6b38', '#164a28', '#0f2f1b']

// Where deferred codes are written, relative to the project; the setting's, set as the module registers.
let deferFile = 'docs/deferred.md'
let projectRoot = ''

// A quick answer's color and the mark it leaves beside its code. An option's
// pick reads as a radio choice, since one reply's options are picked one of.
const SLOT_STYLE: Record<Slot, { glyph: string; color: string }> = {
  go: { glyph: '✓', color: 'green' },
  stop: { glyph: '✗', color: 'red' },
  later: { glyph: '⋯', color: 'yellow' },
}
const TYPED_STYLE = { glyph: '✎', color: 'blue' }

function markFor(prefix: string, answer: string): { glyph: string; color: string } {
  const slot = slotOf(prefix, answer, kinds)
  if (slot === undefined) return TYPED_STYLE
  if (prefix === 'O' && slot === 'go') return { glyph: '◉', color: 'green' }

  return SLOT_STYLE[slot]
}

// What each letter is called and the answers it takes: the settings' kinds, set
// as the module registers (a change in /config reloads it).
let kinds: Kinds = DEFAULT_KINDS

// The six CLAUDE.md letters keep their colors; any other letter takes one from
// the palette by its letters, the same each time.
const KIND_COLORS: Record<string, string> = { F: 'cyan', D: 'magenta', O: 'blue', R: 'red', Q: 'yellow', A: 'green' }
const PALETTE = ['cyan', 'magenta', 'blue', 'yellow', 'green', 'red']

function colorOf(prefix: string): string {
  const hash = [...prefix].reduce((sum, letter) => sum + letter.charCodeAt(0), 0)

  return KIND_COLORS[prefix] ?? PALETTE[hash % PALETTE.length] ?? 'white'
}

// A letter's name: the setting's, else the heading its first code sat under, else the letter.
function nameOf(prefix: string, list: readonly Ref[]): string {
  return kinds.byPrefix[prefix]?.name ?? list.find(ref => ref.prefix === prefix && ref.section !== undefined)?.section ?? prefix
}

// How long after /refs the pane asks for the keyboard: once the command has finished.
const FOCUS_DELAY_MS = 150
// How long to wait before asking again to move the cursor into a field just drawn.
const FOCUS_RETRY_MS = 80
// How often the pane checks the prompt draft, for surfaces whose edits raise no prompt.edit.
const DRAFT_CHECK_MS = 1000

// The transcript row each code was first drawn in, learned as replies draw:
// what a click on the code scrolls to. The module's own, so a reload starts it over.
const sources = new Map<string, string>()

// Moving the keyboard or the view is best effort: a surface that cannot, or a
// row not drawn yet, leaves things where they are.
async function focusOn($: EngineInterface, key: string): Promise<boolean> {
  return (await tryFocus($, key)) === 'moved'
}

// `denied` can change once the pane draws again; `failed` (the surface cannot) will not.
async function tryFocus($: EngineInterface, key: string): Promise<'moved' | 'denied' | 'failed'> {
  try {
    return (await $.ui.focus({ requestId: PANE, key })).deny === undefined ? 'moved' : 'denied'
  } catch {
    // Nothing to do: the person can still click or Tab to it.
    return 'failed'
  }
}

async function scrollTo($: EngineInterface, key: string): Promise<void> {
  try {
    await $.ui.scroll({ in: PANE, to: { key } })
  } catch {
    // Nothing to do: the row is still selected, a scroll away.
  }
}

// Staged answers follow the draft: delete `A2: yes` and A2's mark goes with it.
async function syncStaged($: EngineInterface, draft: string): Promise<void> {
  const answers = readAnswers(draft, await read($, codes), kinds)
  if (!sameAnswers(answers, await read($, staged))) await update($, staged, () => answers)
}

async function setAnswer($: EngineInterface, code: string, answer: string): Promise<void> {
  const draft = stageAnswer((await $.prompt.read()).text, code, answer)
  await $.prompt.fill({ text: draft, mode: 'replace' })
  await syncStaged($, draft)
}

// Defer parks a code: off the list into the folded Deferred group, written to
// the deferred file so it outlives the session, and `A2: deferred` put in the
// prompt so Claude stops working on it. Restore undoes all three.
const DEFERRED_HEADER =
  '# Deferred\n\nCodes set aside in Claude Code conversations with the refs mod. Restoring one in the pane removes its line.\n\n'

// The project is where the session started; a module reloaded without a
// session.start asks the session for it.
async function deferredPath($: EngineInterface): Promise<string> {
  if (deferFile.startsWith('/')) return deferFile
  if (projectRoot === '') projectRoot = await $.session.cwd()

  return `${projectRoot}/${deferFile}`
}

async function readDeferred($: EngineInterface): Promise<string> {
  try {
    return await $.fs.read(await deferredPath($))
  } catch {
    return DEFERRED_HEADER
  }
}

// Each line names its session, so restoring A2 here never removes another conversation's A2.
async function sessionTag($: EngineInterface): Promise<string> {
  return `session ${(await $.session.id()).slice(0, 8)}`
}

async function park($: EngineInterface, ref: Ref): Promise<void> {
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const line = `- **${ref.code}** ${ref.text} · ${day} · ${await sessionTag($)}\n`
  const file = await readDeferred($)
  try {
    await $.fs.write(await deferredPath($), `${file.replace(/\n*$/, '\n')}${line}`)
  } catch (error) {
    $.ui.toast(`Could not write ${deferFile}: ${String(error)}`)
  }
  await update($, parked, list => (list.includes(ref.code) ? list : [...list, ref.code]))
  await setAnswer($, ref.code, DEFERRED)
  $.ui.toast(`${ref.code} deferred to ${deferFile}`)
}

async function restore($: EngineInterface, code: string): Promise<void> {
  const tag = await sessionTag($)
  const file = await readDeferred($)
  const kept = file
    .split('\n')
    .filter(line => !(line.startsWith(`- **${code}** `) && line.endsWith(tag)))
    .join('\n')
  if (kept !== file) {
    try {
      await $.fs.write(await deferredPath($), kept)
    } catch (error) {
      $.ui.toast(`Could not update ${deferFile}: ${String(error)}`)
    }
  }
  await update($, parked, list => list.filter(one => one !== code))
  if ((await read($, staged))[code] === DEFERRED) await setAnswer($, code, '')
}

// A quick answer pressed again is taken back, as a toggle. Picking an option
// takes back any other pick among the options of the same reply.
async function answerRef($: EngineInterface, ref: Ref, slot: Slot): Promise<void> {
  if (slot === 'later') return park($, ref)
  const word = verbsFor(ref.prefix, kinds).find(([one]) => one === slot)?.[1]
  if (word === undefined) return
  const inDraft = await read($, staged)
  const isTakingBack = inDraft[ref.code] === word
  let draft = stageAnswer((await $.prompt.read()).text, ref.code, isTakingBack ? '' : word)
  if (ref.prefix === 'O' && slot === 'go' && !isTakingBack && ref.set !== undefined) {
    for (const other of await read($, codes)) {
      const isRival = other.prefix === 'O' && other.set === ref.set && other.code !== ref.code
      if (isRival && inDraft[other.code] === word) draft = stageAnswer(draft, other.code, '')
    }
  }
  await $.prompt.fill({ text: draft, mode: 'replace' })
  await syncStaged($, draft)
}

async function jumpTo($: EngineInterface, code: string): Promise<void> {
  const requestId = sources.get(code)
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
  if (reason !== undefined) $.ui.toast(`Can't jump to ${code}: ${reason}`)
}

async function putCode($: EngineInterface, code: string): Promise<void> {
  await $.prompt.fill({ text: `${code} `, mode: 'insert' })
}

// btw: a side question about one code over this conversation (`$.model.fork`),
// answered in the pane on every surface and never added to the conversation.
// It opens a field for your question; Enter on an empty one asks for more depth.
// Pressed again while an answer shows, it hides the answer.
async function toggleAside($: EngineInterface, ref: Ref, canType: boolean): Promise<void> {
  if ((await read($, asides)).some(aside => aside.code === ref.code)) {
    await update($, asides, list => list.filter(aside => aside.code !== ref.code))

    return
  }
  if (!canType) return ask($, ref, '')
  await focusOn($, `btw:${ref.code}`)
  await update($, selected, () => ref.code)
  await update($, typing, () => '')
  await update($, asking, () => ref.code)
  await focusField($, `ask:${ref.code}`, 'the btw field')
}

async function ask($: EngineInterface, ref: Ref, typed: string): Promise<void> {
  const question = typed.trim() === '' ? `Explain ${ref.code} in more depth.` : typed.trim()
  await update($, asking, () => '')
  await update($, asides, list => [
    ...list.filter(aside => aside.code !== ref.code),
    { code: ref.code, question, status: 'asking' as const, text: '' },
  ])
  // The fork can outlast a press's time budget, so it runs on a timer of its own.
  $.clock.after(0, async () => {
    const about = `About ${ref.code} ("${ref.text}"): ${question} Answer in a few short paragraphs.`
    let reply = await $.model.fork({ prompt: `Side question, outside the main thread. ${about}` })
    // A session that has sent no request since it started (a desktop session
    // just opened or resumed) has nothing to fork: ask with the reply that
    // defined the code instead.
    if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
      const definedIn = (await $.session.messages()).find(
        message => message.role === 'assistant' && parse(message.text).some(one => one.code === ref.code),
      )
      reply = await $.model.complete({
        model: await $.session.model(),
        prompt: `${definedIn === undefined ? '' : `An assistant wrote:\n\n${definedIn.text}\n\n`}${about}`,
      })
    }
    const answer = reply.isAnswered
      ? { status: 'answered' as const, text: reply.text }
      : { status: 'failed' as const, text: `No answer: ${reply.reason}.` }
    await update($, asides, list => list.map(aside => (aside.code === ref.code ? { ...aside, ...answer } : aside)))
  })
  await focusOn($, `code:${ref.code}`)
}

// The codes in the order j and k walk them: the search's matches, grouped, a
// folded group standing as one stop (its first code) under its header.
function walkOrder(groups: { prefix: string; refs: Ref[] }[], foldedNow: readonly string[]): Ref[] {
  return groups.flatMap(({ prefix, refs }) => (foldedNow.includes(prefix) ? refs.slice(0, 1) : refs))
}

async function shownOrder($: EngineInterface): Promise<Ref[]> {
  const away = await read($, parked)
  const list = (await read($, codes)).filter(ref => !away.includes(ref.code))
  const matches = search(list, await read($, query), prefix => nameOf(prefix, list))

  return walkOrder(group(matches), await read($, folded))
}

async function toggleFold($: EngineInterface, prefix: string): Promise<void> {
  await update($, folded, list => (list.includes(prefix) ? list.filter(one => one !== prefix) : [...list, prefix]))
}

// j and k step through the shown codes, g jumps between the first and the last;
// the selected row is scrolled into the pane's view.
async function move($: EngineInterface, step: 'next' | 'previous' | 'ends'): Promise<void> {
  const order = await shownOrder($)
  if (order.length === 0) return
  const current = await read($, selected)
  const at = order.findIndex(ref => ref.code === current)
  const last = order.length - 1
  const to =
    step === 'ends' ? (at === 0 ? last : 0) : at === -1 ? 0 : Math.min(last, Math.max(0, at + (step === 'next' ? 1 : -1)))
  const code = order[to]?.code ?? ''
  await update($, selected, () => code)
  await scrollTo($, `row:${code}`)
}

// Opening a second field closes the first, and the cursor was in it: the ring
// first moves to this row's type button so the pane keeps the keys, then into
// the new field once it is drawn, trying once more if the drawing was late.
async function typeAnswer($: EngineInterface, code: string): Promise<void> {
  await focusOn($, `type:${code}`)
  await update($, selected, () => code)
  await update($, asking, () => '')
  await update($, typing, () => code)
  await focusField($, `answer:${code}`, `the ${code} field`)
}

async function focusField($: EngineInterface, key: string, name: string): Promise<void> {
  let result = await tryFocus($, key)
  if (result === 'denied') {
    await $.clock.sleep(FOCUS_RETRY_MS)
    result = await tryFocus($, key)
  }
  if (result !== 'moved') $.ui.toast(`Click ${name} to type`)
}

// The type button opens the field, holding any answer typed before so it can be
// edited, and closes it when it is open. remove takes a typed answer back.
async function toggleTyped($: EngineInterface, code: string): Promise<void> {
  if ((await read($, typing)) === code) {
    await update($, typing, () => '')

    return
  }
  await typeAnswer($, code)
}

async function removeTyped($: EngineInterface, code: string): Promise<void> {
  await update($, typing, () => '')
  await setAnswer($, code, '')
}

// Enter closes the field first, so the cursor never stays in a field whose
// answer is already in the prompt, then writes the answer.
async function submitTyped($: EngineInterface, code: string, text: string): Promise<void> {
  await focusOn($, `type:${code}`)
  await update($, typing, () => '')
  await setAnswer($, code, text)
}

async function clearAll($: EngineInterface): Promise<void> {
  await update($, query, () => '')
  await update($, selected, () => '')
  await update($, typing, () => '')
  await update($, asking, () => '')
  await update($, folded, () => [])
  await update($, turn, () => 0)
  await update($, parked, () => [])
  await update($, showDeferred, () => false)
  await update($, codes, () => [])
  await update($, staged, () => ({}))
  await update($, sent, () => ({}))
  await update($, asides, () => [])
}

export const register: Register = (on, options) => {
  // The vim keys are kept but off by default (userConfig `vimKeys`): their row,
  // and /refs taking the keyboard so they work at once.
  const hasVimKeys = options.vimKeys === true
  const setting = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value : undefined)
  kinds = buildKinds({
    builtIn: {
      F: setting(options.findings),
      D: setting(options.decisions),
      O: setting(options.options),
      R: setting(options.risks),
      Q: setting(options.questions),
      A: setting(options.actions),
    },
    other: setting(options.otherKinds),
    otherAnswers: setting(options.otherAnswers),
  })
  deferFile = setting(options.deferFile) ?? 'docs/deferred.md'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'refs',
      description: 'Show the reference codes (F1, D2, A3) of this conversation; /refs clear empties the list',
    })

    projectRoot = e.cwd

    // A resumed session's earlier replies hold codes the list has not seen. A
    // prompt Claude replied to is one turn, as turn.complete counts them (a slash
    // command with no reply is none); a reply's codes belong to its turn.
    const messages = await $.session.messages()
    let turns = 0
    let isAwaitingReply = false
    const found = messages.flatMap((message, at) => {
      const isPrompt = message.role === 'user' && message.text.trim() !== '' && (message.toolResults ?? []).length === 0
      if (isPrompt) isAwaitingReply = true
      if (message.role !== 'assistant') return []
      if (isAwaitingReply) {
        turns++
        isAwaitingReply = false
      }

      return parse(message.text).map(ref => ({ ...ref, set: `message:${at}`, turn: Math.max(1, turns) }))
    })
    await update($, codes, list => merge(list, found))
    await update($, turn, now => Math.max(now, turns))

    $.clock.every(DRAFT_CHECK_MS, async () => {
      if ((await read($, codes)).length > 0) await syncStaged($, (await $.prompt.read()).text)
    })

    return next(e)
  })

  // Subagent turns define codes for their caller, not for you.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const now = (await read($, turn)) + 1
      await update($, turn, () => now)
      const found = parse(e.answer).map(ref => ({ ...ref, set: e.turnId, turn: now }))
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
    const answers = readAnswers(e.text, list, kinds)
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
    await update($, query, () => '')
    await $.ui.open({ id: PANE, title: 'Refs' })
    if (hasVimKeys) {
      // The pane takes the keyboard only over an idle, empty prompt, which this
      // command still holds while it runs: ask again once it has finished, so the
      // letter keys work at once. Escape hands the keys back.
      $.clock.after(FOCUS_DELAY_MS, async () => {
        await $.ui.open({ id: PANE, title: 'Refs', focus: true })
        const pane = (await $.ui.panes()).find(one => one.id === PANE)
        if (pane === undefined) return
        if (!pane.isFocused) {
          $.ui.toast('Press ctrl+x then tab to use the keys in Refs')

          return
        }
        const order = await shownOrder($)
        const before = await read($, selected)
        const code = order.find(ref => ref.code === before)?.code ?? order[0]?.code
        if (code !== undefined) {
          await update($, selected, () => code)
          await focusOn($, `code:${code}`)
        }
      })
    }
    const list = await read($, codes)

    return {
      text: hasVimKeys
        ? `Refs pane opened: ${list.length} codes. j/k move, y/n/d answer, i types an answer, esc returns to the prompt.`
        : `Refs pane opened: ${list.length} codes.`,
    }
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
    // Mobile draws no Input: no search or typed answers there.
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, codes)
    const inDraft = await read($, staged)
    const answered = await read($, sent)
    const open = await read($, asides)
    const searched = await read($, query)
    const typingCode = await read($, typing)
    const askingCode = await read($, asking)

    if (list.length === 0) {
      return <Text dimColor>No reference codes yet. They appear here as Claude defines them.</Text>
    }

    const away = await read($, parked)
    const isDeferredOpen = await read($, showDeferred)
    const turnNow = await read($, turn)
    const matches = search(list, searched, prefix => nameOf(prefix, list))
    const shownRefs = matches.filter(ref => !away.includes(ref.code))
    const deferredRefs = matches.filter(ref => away.includes(ref.code))
    const foldedNow = await read($, folded)
    const order = walkOrder(group(shownRefs), foldedNow)
    const selectedNow = await read($, selected)
    const selectedRef = order.find(ref => ref.code === selectedNow) ?? order[0]
    const selectedCode = selectedRef?.code
    const stagedCount = Object.keys(inDraft).length
    const sentCount = Object.keys(answered).length
    const setQuery = (value: string) => update($, query, () => value)

    // The keyboard: each key is a plain Button whose hotkey works while the pane
    // holds the keys. Drawn as `j: down`, so the row is its own legend.
    const onSelected = (act: (code: string) => Promise<void>) => async () => {
      if (selectedCode !== undefined) await act(selectedCode)
    }
    const hasInput = Input !== undefined
    const KEYS: { key: string; label: string; run: () => Promise<void> }[] = [
      { key: 'j', label: 'down', run: () => move($, 'next') },
      { key: 'k', label: 'up', run: () => move($, 'previous') },
      { key: 'g', label: 'top/end', run: () => move($, 'ends') },
      ...(['y', 'n'] as const).flatMap((key, at) => {
        const verb = selectedRef === undefined ? undefined : verbsFor(selectedRef.prefix, kinds)[at]
        if (verb === undefined) return []
        const [slot, word] = verb

        return [{ key, label: word, run: onSelected(async () => answerRef($, selectedRef as Ref, slot)) }]
      }),
      { key: 'd', label: 'defer', run: onSelected(async () => park($, selectedRef as Ref)) },
      ...(hasInput ? [{ key: 'i', label: 'type', run: onSelected(code => typeAnswer($, code)) }] : []),
      { key: 'x', label: 'clear', run: onSelected(code => setAnswer($, code, '')) },
      {
        key: 'b',
        label: 'btw',
        run: onSelected(async code => {
          const ref = order.find(one => one.code === code)
          if (ref !== undefined) await toggleAside($, ref, hasInput)
        }),
      },
      { key: 'p', label: 'put code', run: onSelected(code => putCode($, code)) },
      {
        key: 'z',
        label: 'fold',
        run: onSelected(async code => {
          const ref = order.find(one => one.code === code)
          if (ref !== undefined) await toggleFold($, ref.prefix)
        }),
      },
      { key: 'o', label: 'open', run: onSelected(code => jumpTo($, code)) },
      ...(hasInput
        ? [{ key: 's', label: 'search', run: async () => void (await focusOn($, 'search')) }]
        : []),
      { key: 'q', label: 'close', run: () => $.ui.close({ id: PANE }) },
    ]

    return (
      <Box flexDirection="column" gap={1} paddingX={1} paddingY={1}>
        {Input !== undefined && (
          <Input
            key="search"
            label="⌕ "
            placeholder="Search codes, text or a group (findings, actions)"
            submitLabel="first match"
            onInput={setQuery}
            onSubmit={async value => {
              await setQuery(value)
              const first = (await shownOrder($))[0]
              if (first !== undefined) {
                await update($, selected, () => first.code)
                await focusOn($, `code:${first.code}`)
              }
            }}
          />
        )}
        {hasVimKeys && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {KEYS.map(({ key, label, run }) => (
              <Button key={`key:${key}`} hotkey={key} label={label} plain dimColor onPress={() => void run()} />
            ))}
          </Box>
        )}
        <Box flexDirection="row" gap={1}>
          <Text bold>
            {searched.trim() === ''
              ? `${shownRefs.length} codes`
              : `${shownRefs.length} of ${list.length - away.length} codes`}
          </Text>
          {stagedCount > 0 && <Text color="cyan">· {stagedCount} in your draft</Text>}
          {sentCount > 0 && <Text dimColor>· {sentCount} answered</Text>}
        </Box>
        {shownRefs.length === 0 && <Text dimColor>No codes match "{searched}".</Text>}

        {group(shownRefs).map(({ prefix, refs }) => {
          const style = { name: nameOf(prefix, list), color: colorOf(prefix) }
          const isFolded = foldedNow.includes(prefix)
          const holdsSelection = refs.some(ref => ref.code === selectedCode)
          const verbs = verbsFor(prefix, kinds)

          return (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={style.color}
              borderDimColor={!holdsSelection}
              paddingX={1}
            >
              <Box key={`group:${prefix}`} flexDirection="row" gap={1}>
                <Button
                  key={`fold:${prefix}`}
                  label={isFolded ? '▸' : '▾'}
                  plain
                  hover={{ color: style.color }}
                  onPress={() => toggleFold($, prefix)}
                />
                <Text bold color={style.color}>
                  {style.name}
                </Text>
                <Text dimColor>{inUse(refs)}</Text>
                {isFolded && holdsSelection && <Text color={style.color}>❮</Text>}
              </Box>

              {/* Each code: a pointer when selected, its mark (a draft answer bright,
                  a sent one dim, else a bullet), the code, and its text wrapping
                  under itself. Under the text: its answers, the typed answer with
                  edit and remove, any open field, and any btw answer. */}
              {(isFolded ? [] : refs).map(ref => {
                const draftAnswer = inDraft[ref.code]
                const sentAnswer = answered[ref.code]
                const shown = draftAnswer ?? sentAnswer
                const mark = shown === undefined ? undefined : markFor(prefix, shown)
                const isSelected = ref.code === selectedCode
                const aside = open.find(one => one.code === ref.code)
                const typed =
                  draftAnswer !== undefined && slotOf(prefix, draftAnswer, kinds) === undefined ? draftAnswer : undefined
                const isFieldOpen = Input !== undefined && typingCode === ref.code
                // Everything under a code lines up with its text.
                const indent = ref.code.length + 5
                const age = ref.turn === undefined ? AGE_BACKGROUND.length : turnNow - ref.turn
                const background = AGE_BACKGROUND[age]

                return (
                  <Box
                    key={`item:${ref.code}`}
                    flexDirection="column"
                    marginTop={1}
                    paddingY={background === undefined ? 0 : 1}
                    backgroundColor={background}
                  >
                    <Box key={`row:${ref.code}`} flexDirection="row" gap={1}>
                      <Text color={style.color}>{isSelected ? '❯' : ' '}</Text>
                      <Text color={mark?.color} dimColor={draftAnswer === undefined}>
                        {mark?.glyph ?? '•'}
                      </Text>
                      <Button
                        key={`code:${ref.code}`}
                        label={ref.code}
                        plain
                        hover={{ color: style.color }}
                        onPress={async () => {
                          await update($, selected, () => ref.code)
                          await jumpTo($, ref.code)
                        }}
                      />
                      <Box flexGrow={1} flexShrink={1}>
                        <Text
                          wrap="wrap"
                          color={isSelected ? style.color : undefined}
                          dimColor={!isSelected && sentAnswer !== undefined && draftAnswer === undefined}
                        >
                          {ref.text}
                        </Text>
                      </Box>
                    </Box>

                    <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginLeft={indent} marginTop={1}>
                      {verbs.map(([slot, word]) => {
                        const isChosen = draftAnswer === word
                        const isRadio = prefix === 'O' && slot === 'go'
                        const marker = isRadio ? (isChosen ? '◉ ' : '○ ') : isChosen ? '● ' : '○ '

                        return (
                          <Box key={`${slot}-box:${ref.code}`} flexDirection="row">
                            <Text color={SLOT_STYLE[slot].color} dimColor={!isChosen}>
                              {marker}
                            </Text>
                            <Button
                              key={`${slot}:${ref.code}`}
                              label={word}
                              plain
                              dimColor={!isChosen}
                              hover={{ color: SLOT_STYLE[slot].color }}
                              onPress={() => answerRef($, ref, slot)}
                            />
                          </Box>
                        )
                      })}
                      <Box key={`defer-box:${ref.code}`} flexDirection="row">
                        <Text color={SLOT_STYLE.later.color} dimColor>
                          ○{' '}
                        </Text>
                        <Button
                          key={`defer:${ref.code}`}
                          label="defer"
                          plain
                          dimColor
                          hover={{ color: SLOT_STYLE.later.color }}
                          onPress={() => park($, ref)}
                        />
                      </Box>
                      {Input !== undefined && (
                        <Box key={`type-box:${ref.code}`} flexDirection="row">
                          <Text color={TYPED_STYLE.color} dimColor={typed === undefined}>
                            {typed === undefined ? '○ ' : '● '}
                          </Text>
                          <Button
                            key={`type:${ref.code}`}
                            label="type"
                            plain
                            dimColor={typed === undefined}
                            hover={{ color: TYPED_STYLE.color }}
                            onPress={() => toggleTyped($, ref.code)}
                          />
                        </Box>
                      )}
                      <Box key={`btw-box:${ref.code}`} flexDirection="row">
                        <Text color="magenta" dimColor={aside === undefined}>
                          {aside === undefined ? '○ ' : '● '}
                        </Text>
                        <Button
                          key={`btw:${ref.code}`}
                          label="btw"
                          plain
                          dimColor={aside === undefined}
                          hover={{ color: 'magenta' }}
                          onPress={() => toggleAside($, ref, Input !== undefined)}
                        />
                      </Box>
                    </Box>

                    {typed !== undefined && !isFieldOpen && (
                      <Box key={`typed:${ref.code}`} flexDirection="row" gap={1} marginLeft={indent} marginTop={1}>
                        <Text color={TYPED_STYLE.color}>✎</Text>
                        <Box flexShrink={1}>
                          <Text wrap="wrap" color={TYPED_STYLE.color}>
                            {typed}
                          </Text>
                        </Box>
                        {Input !== undefined && (
                          <Button key={`edit:${ref.code}`} label="edit" plain dimColor onPress={() => typeAnswer($, ref.code)} />
                        )}
                        <Button key={`remove:${ref.code}`} label="remove" plain dimColor onPress={() => removeTyped($, ref.code)} />
                      </Box>
                    )}

                    {Input !== undefined && isFieldOpen && (
                      <Box marginLeft={indent} marginTop={1}>
                        <Input
                          key={`answer:${ref.code}`}
                          label="✎ "
                          placeholder={`Your answer to ${ref.code}; Enter adds it to your prompt`}
                          value={typed ?? ''}
                          autoFocus
                          submitLabel={typed === undefined ? 'add' : 'update'}
                          onSubmit={value => submitTyped($, ref.code, value)}
                        />
                      </Box>
                    )}

                    {Input !== undefined && askingCode === ref.code && (
                      <Box marginLeft={indent} marginTop={1}>
                        <Input
                          key={`ask:${ref.code}`}
                          autoFocus
                          label="btw "
                          placeholder={`Ask about ${ref.code}; Enter on empty asks for more depth`}
                          submitLabel="ask"
                          onSubmit={value => ask($, ref, value)}
                        />
                      </Box>
                    )}

                    {aside !== undefined && (
                      <Box
                        flexDirection="column"
                        marginLeft={indent}
                        marginTop={1}
                        paddingX={1}
                        borderStyle="round"
                        borderColor="magenta"
                      >
                        <Text color="magenta" bold>
                          btw · {ref.code} · <Text italic>{aside.question}</Text>
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

        {deferredRefs.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="yellow" borderDimColor paddingX={1}>
            <Box key="group:deferred" flexDirection="row" gap={1}>
              <Button
                key="fold:deferred"
                label={isDeferredOpen ? '▾' : '▸'}
                plain
                hover={{ color: 'yellow' }}
                onPress={() => update($, showDeferred, open => !open)}
              />
              <Text bold color="yellow">
                Deferred
              </Text>
              <Text dimColor>
                {deferredRefs.length} · in {deferFile}
              </Text>
            </Box>
            {isDeferredOpen &&
              deferredRefs.map(ref => (
                <Box key={`deferred:${ref.code}`} flexDirection="row" gap={1} marginTop={1}>
                  <Text color="yellow">⋯</Text>
                  <Text dimColor>{ref.code}</Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="wrap" dimColor>
                      {ref.text}
                    </Text>
                  </Box>
                  <Button
                    key={`restore:${ref.code}`}
                    label="restore"
                    plain
                    hover={{ color: 'yellow' }}
                    onPress={() => restore($, ref.code)}
                  />
                </Box>
              ))}
          </Box>
        )}

        <Text dimColor>
          {hasVimKeys
            ? 'Click a code to jump to its reply; p puts it in your prompt. Answers add a line to your prompt; press one again, or delete the line, to take it back. ▾ or z folds a group. ctrl+x tab moves the keyboard into this pane, esc back.'
            : 'Green is new: brightest from the latest reply, fading over two more. Click a code to jump to its reply. Answers add a line to your prompt; press one again, or delete the line, to take it back. defer sets a code aside under Deferred and in the deferred file. ▾ folds a group.'}
        </Text>
      </Box>
    )
  })
}
