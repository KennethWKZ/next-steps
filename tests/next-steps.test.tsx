import { expect, test } from 'claude-code/testing'
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
function engine(on: Parameters<TestBody>[1], suggestions: string = SUGGESTIONS, commands: string[] = []) {
  const box = { text: '' }
  const fills: { text: string; mode: string }[] = []
  on('model.fork', () => ({ value: { isAnswered: true, text: suggestions } }) as never)
  on(
    'command.list',
    () => ({ value: commands.map(name => ({ name, description: name, source: 'plugin' })) }) as never,
  )
  const notes: string[] = []
  on('ui.log', (_, e) => {
    notes.push(`log: ${JSON.stringify(e)}`)
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
  return { box, fills, notes }
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
  for (let i = 0; i < 20; i++) await Promise.resolve()
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
  expect(run.text).toBe('Last suggestions shown above the prompt.')
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
