import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const SUGGESTIONS = JSON.stringify([
  { label: 'run the tests', prompt: 'run the tests you just wrote' },
  { label: 'same for settings', prompt: 'do the same for the settings page' },
  { label: 'commit', prompt: 'commit the change' },
])

const BAND = { plugin: 'next-steps', surface: 'terminal', component: 'AbovePrompt' } as const
const BAND_PROPS = {
  hasSurvey: false,
  isCollapsed: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const LONG_ANSWER = 'Done. '.repeat(30)

// Stands in for the engine: the fork answers SUGGESTIONS, and the prompt box
// is one string that fill writes and read returns.
// The session's $.state as the engine keeps it: one stored value with its
// version, written with ifVersion as update() does. A test seeds it to stand
// for what an earlier load of the module saved before a reload.
type Store = { value: unknown; version: number }

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// Optional parts of the stand-in engine: the store behind the low-effort
// switch (key lowEffortOff; `store` holds the list), the usage each fork
// reports in turn (the last repeats), and a record of what each fork asked.
type Extra = {
  offStore?: Store
  placedStore?: Store
  forkUsage?: Usage[]
  forkRequests?: { effort?: string }[]
  // Ids placed as transcript rows; `placeFails` makes $.ui.place throw.
  places?: string[]
  placeFails?: boolean
  // Commands whose $.command.run rejects, as the engine does past a Stop.
  failCommands?: string[]
  // Commands $.command.list reports as shipping with Claude Code.
  builtins?: string[]
  // Runs inside each command run, before it is recorded (a /clear ending the session).
  onCommand?: (command: string) => Promise<void>
}

function engine(
  on: Parameters<TestBody>[1],
  suggestions: string = SUGGESTIONS,
  commands: string[] = [],
  store: Store = { value: undefined, version: 0 },
  sessionId = 'session-1',
  extra: Extra = {},
) {
  const offStore = extra.offStore ?? { value: undefined, version: 0 }
  const placedStore = extra.placedStore ?? { value: undefined, version: 0 }
  const storeFor = (e: unknown): Store => {
    const key = (e as { key?: string }).key
    return key === 'lowEffortOff' ? offStore : key === 'placed' ? placedStore : store
  }
  on('ui.place', (_, e) => {
    if (extra.placeFails === true) throw new Error('no surface')
    extra.places?.push((e as { id: string }).id)
    return { value: { isPlaced: true, requestId: `r-${(e as { id: string }).id}` } } as never
  })
  on('session.id', () => ({ value: sessionId }) as never)
  on('session.start', (_, e) => ({ cwd: (e as { cwd: string }).cwd }))
  on('session.end', (_, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('state.get', (_, e) => {
    const target = storeFor(e)
    return { value: { value: target.value, version: target.version } } as never
  })
  on('state.set', (_, e) => {
    const target = storeFor(e)
    const write = e as { value: unknown; ifVersion?: number }
    if (write.ifVersion !== undefined && write.ifVersion !== target.version) {
      return { value: { isSet: false, version: target.version } } as never
    }
    target.value = write.value
    target.version += 1
    return { value: { isSet: true, version: target.version } } as never
  })
  const box = { text: '' }
  const fills: { text: string; mode: string }[] = []
  let forks = 0
  on('model.fork', (_, e) => {
    extra.forkRequests?.push({ effort: (e as { effort?: string }).effort })
    const usages = extra.forkUsage ?? []
    const usage = usages[Math.min(forks, usages.length - 1)]
    forks += 1
    return { value: { isAnswered: true, text: suggestions, ...(usage === undefined ? {} : { usage }) } } as never
  })
  on(
    'command.list',
    () =>
      ({
        value: [
          ...commands.map(name => ({ name, description: name, source: 'plugin' })),
          ...(extra.builtins ?? []).map(name => ({ name, description: name, source: 'builtin' })),
        ],
      }) as never,
  )
  const notes: string[] = []
  const logs: string[] = []
  on('ui.log', (_, e) => {
    const line = e as { text: string; to?: string }
    if (line.to !== 'debug') logs.push(line.text)
    return { value: undefined } as never
  })
  on('ui.toast', (_, e) => {
    notes.push(`toast: ${JSON.stringify(e)}`)
    return { value: undefined } as never
  })
  on('prompt.suggest', () => ({ isShown: true }) as never)
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  // Core's own edit: splice what was typed into the draft.
  on('prompt.edit', (_, e) => {
    box.text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text: box.text, cursor: e.start + e.inputText.length }
  })
  on('prompt.fill', (_, e) => {
    fills.push({ text: e.text, mode: e.mode })
    box.text = e.mode === 'append' ? box.text + e.text : e.text
    return { isFilled: true, text: box.text, cursor: box.text.length }
  })
  // Core's own submit: the prompt that entered is the text that arrived.
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  // Core's own command run, recorded in `sent` as typed, so a test sees the
  // order of commands and prompts together.
  on('command.run', async (_, e) => {
    if (extra.failCommands?.includes(e.command)) throw new Error(`no ${e.command} now`)
    await extra.onCommand?.(e.command)
    sent.push(e.args === '' ? `/${e.command}` : `/${e.command} ${e.args}`)
    return { value: { text: '' } } as never
  })
  return { box, fills, notes, logs, sent }
}

// The person (or Heeler, through the composer) sends `text` as a prompt.
async function send($: Parameters<TestBody>[0], text: string, origin: string = 'composer') {
  // The kit raises prompt.submit as the engine does; a plugin's own call
  // could not set the origin.
  const prompt = $.prompt as unknown as { submit: (e: unknown) => Promise<unknown> }
  const result = await prompt.submit({ text, wait: false, origin: { kind: origin } })
  await settle()
  return result
}

async function settle() {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

// The person types one key into the prompt box at `at` (default: the end).
async function type($: Parameters<TestBody>[0], box: { text: string }, ch: string, at = box.text.length) {
  // The kit raises prompt.edit as the composer does; its typings omit it.
  const prompt = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  await prompt.edit({
    origin: { kind: 'composer' },
    key: { key: ch },
    text: box.text,
    cursor: at,
    start: at,
    end: at,
    inputText: ch,
  })
  await settle()
}

async function completeTurn($: Parameters<TestBody>[0], turnId: string) {
  await $.turn.complete({ turnId, reason: 'answer', answer: LONG_ANSWER } as never)
  // The fork runs detached; let it settle.
  await settle()
}

test('picks add up in one draft and the list stays', async ($, on) => {
  const { box, fills, notes } = engine(on)
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  await ui.press({ key: 'pick-0' })
  await ui.press({ key: 'pick-2' })

  expect(fills).toEqual([
    { text: 'run the tests you just wrote', mode: 'replace' },
    { text: '\ncommit the change', mode: 'append' },
  ])
  expect(box.text).toBe('run the tests you just wrote\ncommit the change')
  expect(await ui.find({ key: 'pick-1' })).toBeDefined()
  expect(await ui.find({ key: 'dismiss' })).toBeDefined()

  expect(notes).toEqual([])

  // The same row again, still in the draft: not added twice.
  await ui.press({ key: 'pick-0' })
  expect(fills.length).toBe(2)
  expect(notes).toEqual(['toast: {"text":"already in the draft"}'])

  // Deleted from the draft since: it can go in again.
  box.text = ''
  await ui.press({ key: 'pick-0' })
  expect(fills.length).toBe(3)
  await ui.unmount()
})

test('dismiss hides the list and /next shows it again', async ($, on) => {
  engine(on)
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ key: 'pick-0' })).toBeUndefined()

  const run = await $.command.run({ command: 'next', args: '' } as never)
  expect(run.text).toBe(
    [
      'Last suggestions shown above the prompt.',
      'next steps (send 1, 2 or 3 to use one, several like 1,2, or 9 for all):',
      '  1: run the tests you just wrote',
      '  2: do the same for the settings page',
      '  3: commit the change',
    ].join('\n'),
  )
  const again = await $.ui.mount({ ...BAND, props: BAND_PROPS })
  expect(await again.find({ key: 'pick-0' })).toBeDefined()
  await again.unmount()
  await ui.unmount()
})

test('sending hides the list, /next brings it back with picks marked', async ($, on) => {
  engine(on)
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })
  await ui.press({ key: 'pick-1' })
  await ui.unmount()

  await $.turn.start({ turnId: 't2' } as never)
  const hidden = await $.ui.mount({ ...BAND, props: BAND_PROPS })
  expect(await hidden.find({ key: 'pick-0' })).toBeUndefined()
  await hidden.unmount()

  await $.command.run({ command: 'next', args: '' } as never)
  const shown = await $.ui.mount({ ...BAND, props: BAND_PROPS })
  expect(await shown.find({ key: 'pick-1' })).toBeDefined()
  expect(await shown.find({ text: '(added)' })).toBeDefined()
  await shown.unmount()
})

test('/next with nothing offered yet says so', async $ => {
  const run = await $.command.run({ command: 'next', args: '' } as never)
  expect(run.text).toBe('No next-step suggestions in this session yet.')
})

test('9 adds every suggestion in one fill and marks them all', async ($, on) => {
  const { box, fills, notes } = engine(on)
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  await ui.press({ key: 'add-all' })

  expect(fills).toEqual([
    {
      text: 'run the tests you just wrote\ndo the same for the settings page\ncommit the change',
      mode: 'replace',
    },
  ])
  expect(box.text).toBe('run the tests you just wrote\ndo the same for the settings page\ncommit the change')
  expect(notes).toEqual([])
  expect(await ui.find({ key: 'pick-0' })).toBeDefined()
  expect(await ui.find({ key: 'dismiss' })).toBeDefined()

  // Everything is in the draft: nothing to add.
  await ui.press({ key: 'add-all' })
  expect(fills.length).toBe(1)
  expect(notes).toEqual(['toast: {"text":"all suggestions are already in the draft"}'])
  await ui.unmount()
})

test('9 after a pick appends only the rest, in list order', async ($, on) => {
  const { box, fills } = engine(on)
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  await ui.press({ key: 'pick-1' })
  await ui.press({ key: 'add-all' })

  expect(fills).toEqual([
    { text: 'do the same for the settings page', mode: 'replace' },
    { text: '\nrun the tests you just wrote\ncommit the change', mode: 'append' },
  ])
  expect(box.text).toBe('do the same for the settings page\nrun the tests you just wrote\ncommit the change')
  await ui.unmount()
})

test('9 warns when a slash command ends up with other lines', async ($, on) => {
  const withSlash = JSON.stringify([
    { label: 'review', prompt: '/code-review high' },
    { label: 'commit', prompt: 'commit the change' },
  ])
  const { notes } = engine(on, withSlash, ['code-review'])
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  await ui.press({ key: 'add-all' })

  expect(notes).toEqual([
    'toast: {"text":"a slash command runs only as the whole prompt; check the draft before sending"}',
  ])
  await ui.unmount()
})

test('a single suggestion gets no add-all row', async ($, on) => {
  engine(on, JSON.stringify([{ label: 'commit', prompt: 'commit the change' }]))
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  expect(await ui.find({ key: 'pick-0' })).toBeDefined()
  expect(await ui.find({ key: 'add-all' })).toBeUndefined()
  await ui.unmount()
})

test('right after a fill, typed numbers pick from the list instead of typing', async ($, on) => {
  const { box, fills } = engine(on)
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  await ui.press({ key: 'pick-0' })
  await type($, box, '2')
  expect(box.text).toBe('run the tests you just wrote\ndo the same for the settings page')
  await type($, box, '9')
  expect(box.text).toBe(
    'run the tests you just wrote\ndo the same for the settings page\ncommit the change',
  )
  expect(fills.map(f => f.mode)).toEqual(['replace', 'append', 'append'])

  await type($, box, '0')
  expect(await ui.find({ key: 'pick-0' })).toBeUndefined()
  // Dismissed: numbers type again.
  await type($, box, '3')
  expect(box.text.endsWith('commit the change3')).toBe(true)
  await ui.unmount()
})

test('once the person edits the draft, numbers type as usual', async ($, on) => {
  const { box, fills } = engine(on)
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  await ui.press({ key: 'pick-0' })
  await type($, box, ' ')
  await type($, box, '2')
  expect(box.text).toBe('run the tests you just wrote 2')
  expect(fills.length).toBe(1)
  await ui.unmount()
})

test('a number typed away from the end of the draft types as usual', async ($, on) => {
  const { box, fills } = engine(on)
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  await ui.press({ key: 'pick-0' })
  await type($, box, '2', 0)
  expect(box.text).toBe('2run the tests you just wrote')
  expect(fills.length).toBe(1)
  await ui.unmount()
})

test('two numbers typed back to back both land, in order', async ($, on) => {
  const { box } = engine(on)
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  await ui.press({ key: 'pick-0' })
  const prompt = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  const at = box.text.length
  const key = (ch: string) => ({
    origin: { kind: 'composer' },
    key: { key: ch },
    text: box.text,
    cursor: at,
    start: at,
    end: at,
    inputText: ch,
  })
  await Promise.all([prompt.edit(key('3')), prompt.edit(key('2'))])
  await settle()
  expect(box.text).toBe(
    'run the tests you just wrote\ncommit the change\ndo the same for the settings page',
  )
  await ui.unmount()
})

test('a burst of numbers folded into one edit picks each, in order', async ($, on) => {
  const { box } = engine(on)
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  await ui.press({ key: 'pick-0' })
  const prompt = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  const at = box.text.length
  await prompt.edit({ origin: { kind: 'composer' }, text: box.text, cursor: at, start: at, end: at, inputText: '32' })
  await settle()
  expect(box.text).toBe(
    'run the tests you just wrote\ncommit the change\ndo the same for the settings page',
  )
  await ui.unmount()
})

test('a pasted text with other characters types as usual', async ($, on) => {
  const { box, fills } = engine(on)
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })

  await ui.press({ key: 'pick-0' })
  const prompt = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  const at = box.text.length
  await prompt.edit({ origin: { kind: 'composer' }, text: box.text, cursor: at, start: at, end: at, inputText: ' 2x' })
  await settle()
  expect(box.text).toBe('run the tests you just wrote 2x')
  expect(fills.length).toBe(1)
  await ui.unmount()
})

const PLACED = { plugin: 'next-steps', surface: 'terminal', component: 'Placed' } as const
const HEADER = 'next steps (send 1, 2 or 3 to use one, several like 1,2, or 9 for all):'

// The texts a placed row draws, top to bottom, with each suggestion's number
// and text joined back as the person reads them ("  1: text").
async function rowTexts($: Parameters<TestBody>[0], id: string, plugin = 'next-steps'): Promise<string[]> {
  const ui = await $.ui.mount({ ...PLACED, props: { id, plugin } } as never)
  const texts = ((await ui.findAll({ type: 'Text' } as never)) as { text: string }[]).map(found => found.text)
  await ui.unmount()
  const lines: string[] = []
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i] ?? ''
    if (/^\d+: $/.test(text)) {
      lines.push(`  ${text}${texts[i + 1] ?? ''}`)
      i += 1
    } else {
      lines.push(text)
    }
  }
  return lines
}

// The row's shape: each suggestion is a row of two boxes, the number that
// does not shrink and the text that takes the rest, indented by 2.
test('each suggestion wraps under its own text: number box fixed, text box takes the rest', async ($, on) => {
  engine(on, SUGGESTIONS, [], undefined, 'session-1', { places: [] })
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...PLACED, props: { id: 'l-t1', plugin: 'next-steps' } } as never)
  const boxes = (await ui.findAll({ type: 'Box' } as never)) as { props: Record<string, unknown> }[]
  await ui.unmount()
  const rows = boxes.filter(box => box.props.flexDirection === 'row')
  expect(rows.length).toBe(3)
  for (const row of rows) expect(row.props.marginLeft).toBe(2)
  expect(boxes.filter(box => box.props.flexShrink === 0).length).toBe(3)
  expect(boxes.filter(box => box.props.flexGrow === 1 && box.props.flexShrink === 1).length).toBe(3)
})

test('a new list is placed as one transcript row: header, then each suggestion on its own line', async ($, on) => {
  const places: string[] = []
  const { logs } = engine(on, SUGGESTIONS, [], undefined, 'session-1', { places })
  await completeTurn($, 't1')
  expect(places).toEqual(['l-t1'])
  expect(logs).toEqual([])
  expect(await rowTexts($, 'l-t1')).toEqual([
    HEADER,
    '  1: run the tests you just wrote',
    '  2: do the same for the settings page',
    '  3: commit the change',
  ])
})

test("another plugin's row, or a row whose list is gone, draws nothing from this plugin", async ($, on) => {
  engine(on, SUGGESTIONS, [], undefined, 'session-1', { places: [] })
  await completeTurn($, 't1')
  expect(await rowTexts($, 'l-t1', 'other-plugin')).toEqual([])
  expect(await rowTexts($, 'l-unknown')).toEqual([])
})

test('each list gets its own row, and only the last 20 are kept', async ($, on) => {
  const places: string[] = []
  const placedStore: Store = { value: undefined, version: 0 }
  engine(on, SUGGESTIONS, [], undefined, 'session-1', { places, placedStore })
  for (let i = 1; i <= 21; i++) await completeTurn($, `t${i}`)
  expect(places.length).toBe(21)
  expect(new Set(places).size).toBe(21)
  const kept = (placedStore.value as { value: { id: string }[] }).value
  expect(kept.length).toBe(20)
  expect(kept[0]?.id).toBe('l-t2')
  expect(await rowTexts($, 'l-t1')).toEqual([])
  expect((await rowTexts($, 'l-t21')).length).toBe(4)
})

test('a row id keeps to letters, digits, _ and -', async ($, on) => {
  const places: string[] = []
  engine(on, SUGGESTIONS, [], undefined, 'session-1', { places })
  await completeTurn($, 'turn:42/abc.def')
  expect(places).toEqual(['l-turn42abcdef'])
})

test('after a reload, a row placed earlier still draws its list', async ($, on) => {
  engine(on, SUGGESTIONS, [], undefined, 'session-1', {
    placedStore: { version: 1, value: { shape: 'placed-1', value: [{ id: 'l-old', lines: [HEADER, '  1: commit the change'] }] } },
  })
  await reloadStart($)
  expect(await rowTexts($, 'l-old')).toEqual([HEADER, '  1: commit the change'])
})

test('if placing the row fails, the list goes to the transcript as log lines', async ($, on) => {
  const { logs } = engine(on, SUGGESTIONS, [], undefined, 'session-1', { placeFails: true })
  await completeTurn($, 't1')
  // A failing hook comes back through the engine's error path, later than a settle.
  for (let i = 0; i < 50 && logs.length < 4; i++) await settle()
  expect(logs).toEqual([HEADER, '  1: run the tests you just wrote', '  2: do the same for the settings page', '  3: commit the change'])
})

test('with printSuggestions off, nothing is placed', { options: { printSuggestions: false } }, async ($, on) => {
  const places: string[] = []
  engine(on, SUGGESTIONS, [], undefined, 'session-1', { places })
  await completeTurn($, 't1')
  expect(places).toEqual([])
})

test('the printed list can be turned off', { options: { printSuggestions: false } }, async ($, on) => {
  const { logs } = engine(on)
  await completeTurn($, 't1')
  expect(logs).toEqual([])
})

test('a prompt that is just a number sends that suggestion', async ($, on) => {
  const { sent, logs } = engine(on)
  await completeTurn($, 't1')
  logs.length = 0

  const result = await send($, ' 3\n')
  expect(sent).toEqual(['commit the change'])
  expect(result).toEqual({ text: 'commit the change' })
  expect(logs).toEqual(['next: typed "3"', 'next 3 sent: commit the change'])

  // Picked rows show as added once /next brings the list back.
  await $.turn.start({ turnId: 't2' } as never)
  await $.command.run({ command: 'next', args: '' } as never)
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })
  expect(await ui.find({ text: '(added)' })).toBeDefined()
  await ui.unmount()
})

test('a number from the Remote Control bridge is swapped too', async ($, on) => {
  const { sent } = engine(on)
  await completeTurn($, 't1')
  await send($, '1', 'bridge')
  expect(sent).toEqual(['run the tests you just wrote'])
})

test('a number is left alone when the list is not up', async ($, on) => {
  const { sent } = engine(on)
  // Nothing offered yet.
  await send($, '2')
  await completeTurn($, 't1')
  // Dismissed.
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })
  await ui.press({ key: 'dismiss' })
  await ui.unmount()
  await send($, '2')
  // A new turn hid it.
  await $.command.run({ command: 'next', args: '' } as never)
  await $.turn.start({ turnId: 't2' } as never)
  await send($, '2')
  expect(sent).toEqual(['2', '2', '2'])
})

test('anything but a bare 1-3 from the person goes through as typed', async ($, on) => {
  const { sent } = engine(on)
  await completeTurn($, 't1')
  await send($, '3.')
  await send($, 'option 3')
  await send($, '0')
  await send($, '19')
  await send($, '1;2')
  await send($, '3', 'plugin')
  await send($, '9', 'peer')
  expect(sent).toEqual(['3.', 'option 3', '0', '19', '1;2', '3', '9'])
})

test('a number past a short list goes through as typed', async ($, on) => {
  const { sent } = engine(on, JSON.stringify([{ label: 'commit', prompt: 'commit the change' }]))
  await completeTurn($, 't1')
  await send($, '2')
  expect(sent).toEqual(['2'])
})

test('a number for a slash-command suggestion runs that command', async ($, on) => {
  const withSlash = JSON.stringify([
    { label: 'review', prompt: '/code-review high' },
    { label: 'commit', prompt: 'commit the change' },
  ])
  const clock = mock.clock(on)
  const { sent, logs } = engine(on, withSlash, ['code-review'])
  await completeTurn($, 't1')
  logs.length = 0

  const result = await send($, '1')
  // The typed "1" is dropped; the command runs from its own dispatch.
  expect(result).toEqual({ drop: 'next-steps: 1 runs as a slash command' })
  expect(sent).toEqual([])
  await clock.settle()
  expect(sent).toEqual(['/code-review high'])
  expect(logs).toEqual(['next: typed "1"', 'next 1 queued: /code-review high'])
})

test('several numbers send those suggestions as one prompt, one per line, in the order typed', async ($, on) => {
  const { sent, logs } = engine(on)
  await completeTurn($, 't1')
  logs.length = 0

  await send($, '1,3')
  await send($, '3 1')
  await send($, '21')
  await send($, ' 1, 2 ,3 ')
  expect(sent).toEqual([
    'run the tests you just wrote\ncommit the change',
    'commit the change\nrun the tests you just wrote',
    'do the same for the settings page\nrun the tests you just wrote',
    'run the tests you just wrote\ndo the same for the settings page\ncommit the change',
  ])
  expect(logs.slice(0, 3)).toEqual([
    'next: typed "1,3"',
    'next 1 sent: run the tests you just wrote',
    'next 3 sent: commit the change',
  ])
})

test('a number repeated is sent once', async ($, on) => {
  const { sent } = engine(on)
  await completeTurn($, 't1')
  await send($, '2,2')
  expect(sent).toEqual(['do the same for the settings page'])
})

test('9 sends every suggestion, one per line, and marks them all', async ($, on) => {
  const { sent } = engine(on)
  await completeTurn($, 't1')
  await send($, '9')
  expect(sent).toEqual([
    'run the tests you just wrote\ndo the same for the settings page\ncommit the change',
  ])
  await $.turn.start({ turnId: 't2' } as never)
  await $.command.run({ command: 'next', args: '' } as never)
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })
  for (const key of ['pick-0', 'pick-1', 'pick-2']) {
    const row = await ui.find({ key })
    expect(JSON.stringify(row)).toContain('(added)')
  }
  await ui.unmount()
})

test('several numbers with one past a short list go through as typed', async ($, on) => {
  const twoItems = JSON.stringify([
    { label: 'commit', prompt: 'commit the change' },
    { label: 'push', prompt: 'push the branch' },
  ])
  const { sent } = engine(on, twoItems)
  await completeTurn($, 't1')
  await send($, '1,3')
  await send($, '9')
  expect(sent).toEqual(['1,3', 'commit the change\npush the branch'])
})

test('picks with a slash command go out one after another in the order typed', async ($, on) => {
  const withSlash = JSON.stringify([
    { label: 'review', prompt: '/code-review high' },
    { label: 'commit', prompt: 'commit the change' },
    { label: 'push', prompt: 'push the branch' },
  ])
  const clock = mock.clock(on)
  const { sent, logs } = engine(on, withSlash, ['code-review'])
  await completeTurn($, 't1')
  logs.length = 0

  const result = await send($, '2,1,3')
  expect(result).toEqual({ drop: 'next-steps: 2,1,3 sent one after another' })
  await clock.settle()
  // Plain picks on either side of the command are not merged across it.
  expect(sent).toEqual(['commit the change', '/code-review high', 'push the branch'])
  expect(logs).toEqual([
    'next: typed "2,1,3"',
    'next 2 queued: commit the change',
    'next 1 queued: /code-review high',
    'next 3 queued: push the branch',
  ])
})

test('plain picks next to each other go as one prompt beside the command; 9 picks them all', async ($, on) => {
  const withSlash = JSON.stringify([
    { label: 'review', prompt: '/code-review high' },
    { label: 'commit', prompt: 'commit the change' },
    { label: 'push', prompt: 'push the branch' },
  ])
  const clock = mock.clock(on)
  const { sent, logs } = engine(on, withSlash, ['code-review'])
  await completeTurn($, 't1')
  logs.length = 0

  expect(await send($, '9')).toEqual({ drop: 'next-steps: 1,2,3 sent one after another' })
  await clock.settle()
  expect(sent).toEqual(['/code-review high', 'commit the change\npush the branch'])
  expect(logs).toEqual([
    'next: typed "9"',
    'next 1 queued: /code-review high',
    'next 2,3 queued: commit the change\npush the branch',
  ])
})

test('a command that cannot run stops the rest, and each step not sent is printed', async ($, on) => {
  const withSlash = JSON.stringify([
    { label: 'commit', prompt: 'commit the change' },
    { label: 'review', prompt: '/code-review high' },
    { label: 'push', prompt: 'push the branch' },
  ])
  const clock = mock.clock(on)
  const { sent, logs } = engine(on, withSlash, ['code-review'], undefined, undefined, { failCommands: ['code-review'] })
  await completeTurn($, 't1')
  logs.length = 0

  await send($, '1,2,3')
  await clock.settle()
  expect(sent).toEqual(['commit the change'])
  const after = logs.filter(line => line.includes('not sent') || line.includes('could not be sent'))
  // The kit words the rejection itself; what matters is which step and what follows.
  expect(after[0]?.startsWith('next 2 could not be sent: ')).toBe(true)
  expect(after.slice(1)).toEqual([
    'next 2 not sent: /code-review high',
    'next 3 not sent: push the branch',
  ])
})

test('the typed numbers put back in the box are cleared before the picks go out', async ($, on) => {
  const withSlash = JSON.stringify([
    { label: 'review', prompt: '/code-review high' },
    { label: 'commit', prompt: 'commit the change' },
  ])
  const clock = mock.clock(on)
  const { box, sent } = engine(on, withSlash, ['code-review'])
  await completeTurn($, 't1')

  await send($, '1,2')
  // The engine puts a dropped prompt back into the box.
  box.text = '1,2'
  await clock.settle()
  expect(box.text).toBe('')
  expect(sent).toEqual(['/code-review high', 'commit the change'])

  // Anything else in the box is the person's own and stays.
  await completeTurn($, 't2')
  await send($, '2,1')
  box.text = 'my own draft'
  await clock.settle()
  expect(box.text).toBe('my own draft')
})

test("this plugin's own commands are never offered", async ($, on) => {
  const withOwn = JSON.stringify([
    { label: 'show again', prompt: '/next' },
    { label: 'commit', prompt: 'commit the change' },
  ])
  const { sent } = engine(on, withOwn, ['next', 'next-compare'])
  await completeTurn($, 't1')
  await send($, '1')
  expect(sent).toEqual(['commit the change'])
})

test('a built-in that ends or empties the session is never offered; other built-ins are', async ($, on) => {
  const withBuiltins = JSON.stringify([
    { label: 'clear', prompt: '/clear' },
    { label: 'review', prompt: '/code-review high' },
    { label: 'commit', prompt: 'commit the change' },
  ])
  const clock = mock.clock(on)
  const { sent } = engine(on, withBuiltins, [], undefined, undefined, { builtins: ['clear', 'code-review'] })
  await completeTurn($, 't1')
  // The list is now review, commit: 9 runs the review, then sends the commit.
  await send($, '9')
  await clock.settle()
  expect(sent).toEqual(['/code-review high', 'commit the change'])
})

test('when the session ends between steps, the rest is printed and not sent', async ($, on) => {
  const withSlash = JSON.stringify([
    { label: 'review', prompt: '/code-review high' },
    { label: 'commit', prompt: 'commit the change' },
  ])
  const clock = mock.clock(on)
  const onCommand = async () => {
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } } as never)
  }
  const { sent, logs } = engine(on, withSlash, ['code-review'], undefined, undefined, { onCommand })
  await completeTurn($, 't1')
  await send($, '1,2')
  await clock.settle()
  expect(sent).toEqual(['/code-review high'])
  expect(logs.filter(line => line.includes('not sent') || line.includes('could not be sent'))).toEqual([
    'next 2 could not be sent: the session ended',
    'next 2 not sent: commit the change',
  ])
})

test('a prompt the plugin sends is not read as a pick', async ($, on) => {
  const withSlash = JSON.stringify([
    { label: 'review', prompt: '/code-review high' },
    { label: 'one', prompt: '1' },
  ])
  const clock = mock.clock(on)
  const { sent } = engine(on, withSlash, ['code-review'])
  await completeTurn($, 't1')
  await send($, '1,2')
  await clock.settle()
  // The plugin's own "1" is plain text, not suggestion 1 again.
  expect(sent).toEqual(['/code-review high', '1'])
})

test('the raw input is logged before the swap, so 9 and 1,2,3 can be told apart', async ($, on) => {
  const { sent, logs } = engine(on)
  await completeTurn($, 't1')
  logs.length = 0
  await send($, '9')
  await send($, '1,2,3')
  expect(sent[0]).toBe(sent[1])
  expect(logs.filter(line => line.startsWith('next: typed'))).toEqual(['next: typed "9"', 'next: typed "1,2,3"'])
})

test('a prompt sent as typed logs nothing', async ($, on) => {
  const { logs } = engine(on)
  await completeTurn($, 't1')
  logs.length = 0
  await send($, '3.')
  expect(logs).toEqual([])
})

test('the suggester is told never to claim the user already did something', async ($, on) => {
  const prompts: string[] = []
  on('model.fork', (_, e) => {
    prompts.push((e as { prompt: string }).prompt)
    return { value: { isAnswered: true, text: SUGGESTIONS } } as never
  })
  on('command.list', () => ({ value: [] }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('prompt.suggest', () => ({ isShown: true }) as never)
  on('turn.complete', () => ({ text: '' }))
  await completeTurn($, 't1')
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('never state that the user already did something')
})

// What an earlier load of the module saved, as $.state holds it for a shaped atom.
function savedBefore(overrides: Record<string, unknown> = {}, shape = 'list-1'): Store {
  return {
    version: 3,
    value: {
      shape,
      value: {
        sessionId: 'session-1',
        items: JSON.parse(SUGGESTIONS),
        picked: [false, true, false],
        isUp: true,
        ...overrides,
      },
    },
  }
}

async function reloadStart($: Parameters<TestBody>[0]) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
}

test('each new list, and each pick, is saved to $.state with the session id', async ($, on) => {
  const store: Store = { value: undefined, version: 0 }
  engine(on, SUGGESTIONS, [], store)
  await completeTurn($, 't1')
  expect(store.value).toEqual({
    shape: 'list-1',
    value: { sessionId: 'session-1', items: JSON.parse(SUGGESTIONS), picked: [false, false, false], isUp: true },
  })
  await send($, '2')
  expect((store.value as { value: { picked: boolean[] } }).value.picked).toEqual([false, true, false])
})

test('after a reload, a number sent right away still swaps', async ($, on) => {
  const { sent, logs } = engine(on, SUGGESTIONS, [], savedBefore())
  await reloadStart($)
  await send($, '3')
  expect(sent).toEqual(['commit the change'])
  expect(logs).toEqual(['next: typed "3"', 'next 3 sent: commit the change'])
})

test('after a reload, the list shows again with its picks marked', async ($, on) => {
  engine(on, SUGGESTIONS, [], savedBefore())
  await reloadStart($)
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })
  expect(await ui.find({ key: 'pick-0' })).toBeDefined()
  expect(JSON.stringify(await ui.find({ key: 'pick-1' }))).toContain('(added)')
  await ui.unmount()
})

test('a list saved while hidden is back for /next but does not swap numbers', async ($, on) => {
  const { sent } = engine(on, SUGGESTIONS, [], savedBefore({ isUp: false }))
  await reloadStart($)
  await send($, '3')
  expect(sent).toEqual(['3'])
  const run = await $.command.run({ command: 'next', args: '' } as never)
  expect(run.text).toContain('  3: commit the change')
})

test('a list saved in another session is not read back', async ($, on) => {
  const { sent } = engine(on, SUGGESTIONS, [], savedBefore({ sessionId: 'session-0' }))
  await reloadStart($)
  await send($, '3')
  expect(sent).toEqual(['3'])
})

test('a list an older version stored, or a broken one, is not read back', async ($, on) => {
  const { sent } = engine(on, SUGGESTIONS, [], savedBefore({}, 'list-0'))
  await reloadStart($)
  await send($, '1')
  expect(sent).toEqual(['1'])
})

test('a saved list with the wrong fields is not read back', async ($, on) => {
  const { sent } = engine(on, SUGGESTIONS, [], savedBefore({ picked: [true] }))
  await reloadStart($)
  await send($, '1')
  expect(sent).toEqual(['1'])
})

test('a /clear drops the list: a number sent after it goes through as typed', async ($, on) => {
  const store: Store = { value: undefined, version: 0 }
  const { sent } = engine(on, SUGGESTIONS, [], store)
  await completeTurn($, 't1')
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } } as never)
  await settle()
  await send($, '3')
  expect(sent).toEqual(['3'])
  expect((store.value as { value: unknown }).value).toBeNull()
})

// Compare mode: the small model's request, answered here.
const HAIKU_SUGGESTIONS = JSON.stringify([
  { label: 'tests', prompt: 'run the tests' },
  { label: 'docs', prompt: 'update the README' },
])

function haiku(on: Parameters<TestBody>[1], reply: unknown = { isAnswered: true, text: HAIKU_SUGGESTIONS, usage: { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) {
  const requests: { model: string; prompt: string }[] = []
  let now = 0
  on('clock.now', () => ({ value: (now += 500) }) as never)
  on('model.complete', (_, e) => {
    requests.push(e as { model: string; prompt: string })
    return { value: reply } as never
  })
  return requests
}

async function compare($: Parameters<TestBody>[0], args = '') {
  return $.command.run({ command: 'next-compare', args } as never)
}

// The lines kept for a placed row, as the Placed render reads them.
function placedLines(store: Store, id: string): string[] {
  const kept = (store.value as { value?: { id: string; lines: string[] }[] } | undefined)?.value ?? []
  return kept.find(entry => entry.id === id)?.lines ?? []
}

test('compare mode asks haiku with the last prompt and answer, and places both lists as one row', async ($, on) => {
  const placedStore: Store = { value: undefined, version: 0 }
  const places: string[] = []
  const { logs, sent } = engine(on, SUGGESTIONS, [], undefined, 'session-1', { placedStore, places })
  const requests = haiku(on)
  const run = await compare($)
  expect(run.text).toContain('next 5 answer(s)')
  await send($, 'fix the flaky login test')
  await completeTurn($, 't1')
  // The row is placed once the fork, haiku and the state write are all done.
  for (let i = 0; i < 50 && places.length === 0; i++) await settle()

  expect(requests.length).toBe(1)
  expect(requests[0]?.model).toBe('haiku')
  expect(requests[0]?.prompt).toContain('<last-user-prompt>\nfix the flaky login test\n</last-user-prompt>')
  expect(requests[0]?.prompt).toContain(LONG_ANSWER.trim())
  // One placed row for the compare block, in place of the list's row; no log lines.
  expect(places).toEqual(['c-t1'])
  expect(logs).toEqual([])
  const lines = placedLines(placedStore, 'c-t1')
  expect(lines[0]).toContain('compare: session model (fork, whole session) vs haiku')
  expect(lines[0]).toContain('4 more turn(s)')
  expect(lines.slice(1, 7)).toEqual([
    '  1 fork : run the tests you just wrote',
    '    haiku: run the tests',
    '  2 fork : do the same for the settings page',
    '    haiku: update the README',
    '  3 fork : commit the change',
    '    haiku: (none)',
  ])
  expect(lines[7]).toMatch(/^ {2}fork: \d+\.\d s, usage not reported$/)
  expect(lines[8]).toMatch(/^ {2}haiku: \d+\.\d s, in 900, out 60 tokens$/)
  // Numbers still pick from the fork's list.
  await send($, '3')
  expect(sent.at(-1)).toBe('commit the change')
})

test('the compare row lines up: fixed labels, text that wraps under itself, haiku under fork', async ($, on) => {
  engine(on, SUGGESTIONS, [], undefined, 'session-1', { places: [] })
  haiku(on)
  await compare($, '1')
  await completeTurn($, 't1')
  const ui = await $.ui.mount({ ...PLACED, props: { id: 'c-t1', plugin: 'next-steps' } } as never)
  const boxes = (await ui.findAll({ type: 'Box' } as never)) as { props: Record<string, unknown> }[]
  const texts = ((await ui.findAll({ type: 'Text' } as never)) as { text: string }[]).map(found => found.text)
  await ui.unmount()
  // Three fork rows, three haiku rows and two timing rows, each a label and a text box.
  const rows = boxes.filter(box => box.props.flexDirection === 'row')
  expect(rows.length).toBe(8)
  expect(rows.map(row => row.props.marginLeft)).toEqual([2, 4, 2, 4, 2, 4, 2, 2])
  expect(texts.slice(1, 5)).toEqual(['1 fork : ', 'run the tests you just wrote', 'haiku: ', 'run the tests'])
  // "  1 fork : " and "    haiku: " are both 11 wide, so the two texts start in the same column.
  expect(2 + '1 fork : '.length).toBe(4 + 'haiku: '.length)
})

test('compare mode ends after its turns, and the plain list comes back', async ($, on) => {
  const places: string[] = []
  const placedStore: Store = { value: undefined, version: 0 }
  engine(on, SUGGESTIONS, [], undefined, 'session-1', { places, placedStore })
  const requests = haiku(on)
  await compare($, '2')
  await completeTurn($, 't1')
  await completeTurn($, 't2')
  expect(placedLines(placedStore, 'c-t2')[0]).toContain('last compare turn')
  await completeTurn($, 't3')
  expect(requests.length).toBe(2)
  expect(places).toEqual(['c-t1', 'c-t2', 'l-t3'])
})

test('/next-compare off stops it, and a bad count is refused', async ($, on) => {
  engine(on)
  const requests = haiku(on)
  expect((await compare($, 'lots')).text).toContain('Usage: /next-compare')
  expect((await compare($, '21')).text).toContain('Usage: /next-compare')
  await compare($, '3')
  expect((await compare($, 'off')).text).toBe('Compare mode off.')
  await completeTurn($, 't1')
  expect(requests.length).toBe(0)
})

test('a failed haiku request still leaves the fork list in place', async ($, on) => {
  const placedStore: Store = { value: undefined, version: 0 }
  const { sent } = engine(on, SUGGESTIONS, [], undefined, 'session-1', { placedStore, places: [] })
  haiku(on, { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' })
  await compare($, '1')
  await completeTurn($, 't1')
  const lines = placedLines(placedStore, 'c-t1')
  expect(lines.some(line => /^ {2}haiku: failed after \d+\.\d s: no reply \(api-error\)$/.test(line))).toBe(true)
  expect(lines).toContain('    haiku: (none)')
  await send($, '1')
  expect(sent.at(-1)).toBe('run the tests you just wrote')
})

test('if placing the compare row fails, its lines go to the transcript as log lines', async ($, on) => {
  const { logs } = engine(on, SUGGESTIONS, [], undefined, 'session-1', { placeFails: true })
  haiku(on)
  await compare($, '1')
  await completeTurn($, 't1')
  for (let i = 0; i < 50 && logs.length < 9; i++) await settle()
  expect(logs[0]).toContain('compare: session model')
  expect(logs[1]).toBe('  1 fork : run the tests you just wrote')
})

test('a swapped number is what haiku sees as the last prompt', async ($, on) => {
  engine(on)
  const requests = haiku(on)
  await completeTurn($, 't1')
  await compare($, '1')
  await send($, '2')
  await completeTurn($, 't2')
  expect(requests[0]?.prompt).toContain('<last-user-prompt>\ndo the same for the settings page\n</last-user-prompt>')
})

test('the fork request asks for low effort', async ($, on) => {
  const requests: { prompt: string; effort?: string }[] = []
  on('model.fork', (_, e) => {
    requests.push(e as { prompt: string; effort?: string })
    return { value: { isAnswered: true, text: SUGGESTIONS } } as never
  })
  on('command.list', () => ({ value: [] }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('prompt.suggest', () => ({ isShown: true }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('state.get', () => ({ value: { value: undefined, version: 0 } }) as never)
  on('state.set', () => ({ value: { isSet: true, version: 1 } }) as never)
  on('turn.complete', () => ({ text: '' }))
  await completeTurn($, 't1')
  expect(requests.length).toBe(1)
  expect(requests[0]?.effort).toBe('low')
})

// Fork usage as the API reports it.
const SHARED_CACHE: Usage = { input_tokens: 3342, output_tokens: 300, cache_read_input_tokens: 371220, cache_creation_input_tokens: 1802 }
const SECOND_COPY: Usage = { input_tokens: 3342, output_tokens: 300, cache_read_input_tokens: 4100, cache_creation_input_tokens: 352000 }
const BIG_TOOL_OUTPUT: Usage = { input_tokens: 3342, output_tokens: 300, cache_read_input_tokens: 371220, cache_creation_input_tokens: 48000 }

test('a fork that shares the cache keeps low effort', async ($, on) => {
  const forkRequests: { effort?: string }[] = []
  const { logs } = engine(on, SUGGESTIONS, [], undefined, 'session-1', { forkUsage: [SHARED_CACHE], forkRequests })
  await completeTurn($, 't1')
  await completeTurn($, 't2')
  expect(forkRequests.map(r => r.effort)).toEqual(['low', 'low'])
  expect(logs.some(line => line.startsWith('low effort made'))).toBe(false)
})

test('a second cache copy turns low effort off for the session, with one line', async ($, on) => {
  const forkRequests: { effort?: string }[] = []
  const offStore: Store = { value: undefined, version: 0 }
  const { logs } = engine(on, SUGGESTIONS, [], undefined, 'session-1', {
    forkUsage: [SECOND_COPY, SHARED_CACHE],
    forkRequests,
    offStore,
  })
  await completeTurn($, 't1')
  await completeTurn($, 't2')
  await completeTurn($, 't3')
  expect(forkRequests.map(r => r.effort)).toEqual(['low', undefined, undefined])
  expect(logs.filter(line => line.startsWith('low effort made'))).toEqual([
    "low effort made a second cache copy (wrote 352000 tokens, read 4100): suggestions use the session's effort for the rest of this session",
  ])
  expect(offStore.value).toEqual({ shape: 'off-1', value: 'session-1' })
  // The list still works as usual.
  // The list itself still goes out as usual (a placed row; no log lines besides the switch).
  expect(logs.length).toBe(1)
})

test('a big write that is still smaller than the read keeps low effort', async ($, on) => {
  const forkRequests: { effort?: string }[] = []
  const { logs } = engine(on, SUGGESTIONS, [], undefined, 'session-1', { forkUsage: [BIG_TOOL_OUTPUT], forkRequests })
  await completeTurn($, 't1')
  await completeTurn($, 't2')
  expect(forkRequests.map(r => r.effort)).toEqual(['low', 'low'])
  expect(logs.some(line => line.startsWith('low effort made'))).toBe(false)
})

test('the threshold is an option', { options: { cacheCheckTokens: 400000 } }, async ($, on) => {
  const forkRequests: { effort?: string }[] = []
  engine(on, SUGGESTIONS, [], undefined, 'session-1', { forkUsage: [SECOND_COPY], forkRequests })
  await completeTurn($, 't1')
  await completeTurn($, 't2')
  expect(forkRequests.map(r => r.effort)).toEqual(['low', 'low'])
})

test('after a reload, a session already found to copy stays off low effort', async ($, on) => {
  const forkRequests: { effort?: string }[] = []
  engine(on, SUGGESTIONS, [], undefined, 'session-1', {
    offStore: { value: { shape: 'off-1', value: 'session-1' }, version: 2 },
    forkUsage: [SHARED_CACHE],
    forkRequests,
  })
  await reloadStart($)
  await completeTurn($, 't1')
  expect(forkRequests.map(r => r.effort)).toEqual([undefined])
})

test('a switch saved in another session does not apply', async ($, on) => {
  const forkRequests: { effort?: string }[] = []
  engine(on, SUGGESTIONS, [], undefined, 'session-2', {
    offStore: { value: { shape: 'off-1', value: 'session-1' }, version: 2 },
    forkUsage: [SHARED_CACHE],
    forkRequests,
  })
  await reloadStart($)
  await completeTurn($, 't1')
  expect(forkRequests.map(r => r.effort)).toEqual(['low'])
})

test("a subagent's turn neither asks for a list nor hides the main one", async ($, on) => {
  const forkRequests: { effort?: string }[] = []
  const places: string[] = []
  engine(on, SUGGESTIONS, [], undefined, 'session-1', { forkRequests, places })
  await completeTurn($, 't1')
  expect(forkRequests.length).toBe(1)
  // A subagent runs and finishes inside the next main turn.
  await $.turn.start({ turnId: 'a1', agentId: 'agent-1', text: 'review the diff' } as never)
  await $.turn.complete({ turnId: 'a1', agentId: 'agent-1', reason: 'answer', answer: LONG_ANSWER } as never)
  await settle()
  expect(forkRequests.length).toBe(1)
  expect(places).toEqual(['l-t1'])
  // The main list is still up.
  const ui = await $.ui.mount({ ...BAND, props: BAND_PROPS })
  expect(await ui.find({ key: 'pick-0' })).toBeDefined()
  await ui.unmount()
})
