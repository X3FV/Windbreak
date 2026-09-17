import { describe, expect, test } from 'bun:test'

import {
  buildQueueChatLines,
  describeQueueBudget,
  describeQueueChatTarget,
  describeQueueProposal,
  describeQueueRefusal,
  parseQueueChatInput,
  QUEUE_CHAT_EXHAUSTED_NOTE,
  QUEUE_HUNT_PREFIX,
} from '../queue-chat-content'

import type { ConversationBudgetState, ProviderFailure } from '@codebuff/windbreak/review'
import type { QueueChatTurn } from '../queue-chat-content'
import type { QueueLine } from '../queue-content'

/**
 * Every word the pane's lines carry, in order, run together as prose.
 *
 * Joined with a space rather than a newline because a sentence here is several lines: the copy is
 * wrapped by hand so it reads well on a narrow terminal, and an assertion that had to guess where
 * the breaks fall would be testing the wrap instead of the wording.
 */
const text = (lines: readonly QueueLine[]): string =>
  lines
    .map((line) =>
      line.kind === 'field'
        ? `${line.label} ${line.value}`
        : line.kind === 'text'
          ? line.text
          : line.label,
    )
    .join(' ')

const budget = (overrides: Partial<ConversationBudgetState> = {}): ConversationBudgetState => ({
  calls: 1,
  limit: 40,
  turns: 1,
  tokens: 0,
  exhausted: false,
  remaining: 39,
  ...overrides,
})

const turn = (overrides: Partial<QueueChatTurn> = {}): QueueChatTurn => ({
  agent: 'investigator',
  mode: 'explain',
  prompt: 'who calls this?',
  answer: 'the socket reader does',
  error: null,
  cancelled: false,
  pending: false,
  writes: [],
  proposals: [],
  proposalRejections: [],
  injectionSignals: [],
  toolsUsed: [],
  recordedTurnId: 'turn-1',
  budget: budget(),
  ...overrides,
})

describe('parseQueueChatInput', () => {
  test('a line with nothing in it is not a question', () => {
    expect(parseQueueChatInput('', 'explain')).toBeNull()
    expect(parseQueueChatInput('   \n ', 'explain')).toBeNull()
    // A bare `/hunt` would spend a model call to ask nothing. The pane refuses it rather than
    // sending it as an empty hunt.
    expect(parseQueueChatInput(QUEUE_HUNT_PREFIX, 'explain')).toBeNull()
    expect(parseQueueChatInput(`  ${QUEUE_HUNT_PREFIX}  `, 'explain')).toBeNull()
  })

  test('/hunt asks the whole target, and the rest of the line is the question', () => {
    expect(parseQueueChatInput('/hunt find string copies', 'explain')).toEqual({
      mode: 'hunt',
      prompt: 'find string copies',
    })
    expect(parseQueueChatInput('/hunt find string copies', 'hunt')).toEqual({
      mode: 'hunt',
      prompt: 'find string copies',
    })
  })

  test('a plain question runs in the mode the selection implies', () => {
    expect(parseQueueChatInput('  is the length capped? ', 'explain')).toEqual({
      mode: 'explain',
      prompt: 'is the length capped?',
    })
    // With no row selected the fallback is a hunt, which is how `nextMode` reads an empty queue.
    expect(parseQueueChatInput('what does this binary do?', 'hunt')).toEqual({
      mode: 'hunt',
      prompt: 'what does this binary do?',
    })
  })

  test('a word that merely starts with /hunt is a question, not a mode', () => {
    expect(parseQueueChatInput('/hunting is not a mode', 'explain')).toEqual({
      mode: 'explain',
      prompt: '/hunting is not a mode',
    })
  })
})

describe('describeQueueBudget', () => {
  test('the pair is spent and ceiling, never only what is left', () => {
    expect(describeQueueBudget(budget())).toBe('budget: 1/40 model calls · 1 turn')
    // A remaining count alone cannot tell "nearly over" from "barely begun", so the ceiling is
    // always named alongside the spend.
    expect(describeQueueBudget(budget({ calls: 39, remaining: 1 }))).toBe(
      'budget: 39/40 model calls · 1 turn',
    )
  })

  test('no turns yet is said rather than counted as zero', () => {
    expect(describeQueueBudget(budget({ calls: 0, turns: 0, remaining: 40 }))).toContain(
      'no turns yet',
    )
    expect(describeQueueBudget(budget({ turns: 3 }))).toContain('3 turns')
  })

  test('tokens are abbreviated, and a zero is left unsaid', () => {
    expect(describeQueueBudget(budget({ tokens: 900 }))).toContain('900 tokens')
    expect(describeQueueBudget(budget({ tokens: 12_400 }))).toContain('12.4k tokens')
    expect(describeQueueBudget(budget({ tokens: 0 }))).not.toContain('tokens')
  })

  test('a spent ceiling says spent', () => {
    expect(
      describeQueueBudget(
        budget({ calls: 40, turns: 9, tokens: 9000, exhausted: true, remaining: 0 }),
      ),
    ).toBe('budget spent: 40/40 model calls · 9 turns · 9.0k tokens')
  })

  test('a caller without a bridge has no line rather than a wrong one', () => {
    expect(describeQueueBudget(null)).toBe('')
  })
})

describe('describeQueueChatTarget', () => {
  test('the selected row is named, so the question cannot be about another', () => {
    expect(
      describeQueueChatTarget({
        candidateId: 'cand-1',
        mode: 'explain',
        filePath: 'src/handler.c',
        startLine: 6,
      }),
    ).toBe('about src/handler.c:6')
  })

  test('a candidate with no line, or no location at all, says which', () => {
    expect(
      describeQueueChatTarget({
        candidateId: 'cand-1',
        mode: 'explain',
        filePath: 'src/handler.c',
        startLine: null,
      }),
    ).toBe('about src/handler.c')
    expect(
      describeQueueChatTarget({
        candidateId: 'cand-1',
        mode: 'explain',
        filePath: null,
        startLine: null,
      }),
    ).toBe('about a candidate with no location on record')
  })

  test('an empty queue says the questions are about the target, not a row', () => {
    expect(
      describeQueueChatTarget({ candidateId: null, mode: 'explain', filePath: null, startLine: null }),
    ).toBe('no candidate selected — questions are answered about the target as a whole')
  })

  test('a hunt says its candidates are recorded, not decided', () => {
    const line = describeQueueChatTarget({
      candidateId: 'cand-1',
      mode: 'hunt',
      filePath: 'src/handler.c',
      startLine: 6,
    })
    expect(line).toContain('hunting the whole target')
    expect(line).toContain('recorded, not decided')
  })
})

describe('describeQueueProposal', () => {
  test('the class is the model\u2019s own label, and it is said to be', () => {
    expect(
      describeQueueProposal({
        filePath: 'src/other.c',
        startLine: 12,
        endLine: 12,
        cwe: 'CWE-787',
        claim: 'x',
      }),
    ).toBe('src/other.c:12 (CWE-787, as the model labelled it)')
  })

  test('a range is a range, and a site with no class says nothing', () => {
    expect(
      describeQueueProposal({
        filePath: 'src/other.c',
        startLine: 12,
        endLine: 20,
        cwe: null,
        claim: 'x',
      }),
    ).toBe('src/other.c:12-20')
  })
})

describe('buildQueueChatLines', () => {
  test('an untouched pane states the terms it answers under', () => {
    const lines = text(buildQueueChatLines([]))
    expect(lines).toContain('It does not decide anything')
    expect(lines).toContain('it cannot change it')
  })

  test('the terms stay at the head of a transcript that has answers in it', () => {
    // The pane drops nothing when the first answer arrives: the sentence that says an answer is not
    // a decision is the one a reader is most likely to want back, and a transcript that replaced it
    // would go on answering under terms the reader never saw.
    const lines = text(buildQueueChatLines([turn()]))
    expect(lines).toContain('It does not decide anything')
    expect(lines).toContain('you › who calls this?')
    expect(lines).toContain('the socket reader does')
  })

  test('a pending turn cannot show an answer it does not have yet', () => {
    const lines = text(
      buildQueueChatLines([turn({ pending: true, answer: 'a guess rendered early' })]),
    )
    expect(lines).toContain('investigating')
    expect(lines).toContain('esc stops it')
    expect(lines).not.toContain('a guess rendered early')
  })

  test('a stopped turn is cancelled, and is not also a failure or an empty answer', () => {
    const lines = text(buildQueueChatLines([turn({ cancelled: true, answer: null })]))
    expect(lines).toContain('cancelled — you stopped this turn')
    expect(lines).not.toContain('(no answer)')
  })

  test('an error is labelled, and does not double as "(no answer)"', () => {
    const lines = text(buildQueueChatLines([turn({ error: 'the model call failed', answer: null })]))
    expect(lines).toContain('! the model call failed')
    expect(lines).not.toContain('(no answer)')
  })

  test('a turn that answered nothing says so', () => {
    expect(text(buildQueueChatLines([turn({ answer: null })]))).toContain('(no answer)')
    // Whitespace is not an answer either.
    expect(text(buildQueueChatLines([turn({ answer: '   ' })]))).toContain('(no answer)')
  })

  test('an engineer turn is named, because it held a writable copy', () => {
    const lines = text(buildQueueChatLines([turn({ agent: 'engineer' })]))
    expect(lines).toContain('you (engineer) › who calls this?')
  })

  test('a hunt and an engineer are both named, and neither is when neither applies', () => {
    expect(text(buildQueueChatLines([turn({ mode: 'hunt' })]))).toContain('you (hunt) ›')
    expect(text(buildQueueChatLines([turn()]))).toContain('you › who calls this?')
  })

  test('a failing write is attributed to the copy, and the target is said to be unchanged', () => {
    const lines = text(
      buildQueueChatLines([
        turn({ writes: [{ action: 'update', path: 'src/handler.c', inserted: 2, removed: 1 }] }),
      ]),
    )
    expect(lines).toContain('edited 1 file in the working copy')
    expect(lines).toContain('update src/handler.c (+2/-1)')
    expect(lines).toContain('the target is unchanged')
  })

  test('a recorded candidate is recorded, not assessed', () => {
    const lines = text(
      buildQueueChatLines([
        turn({
          proposals: [
            { filePath: 'src/other.c', startLine: 12, endLine: 12, cwe: 'CWE-787', claim: 'x' },
          ],
        }),
      ]),
    )
    expect(lines).toContain('recorded 1 candidate')
    expect(lines).toContain('still have to pass triage and verification')
    expect(lines).toContain('CWE-787, as the model labelled it')
  })

  test('a proposal aimed at a file that is not there is shown', () => {
    const lines = text(
      buildQueueChatLines([
        turn({
          proposalRejections: [{ requestedPath: '/etc/passwd', reason: 'outside the target' }],
        }),
      ]),
    )
    expect(lines).toContain('refused /etc/passwd: outside the target')
  })

  test('content that tried to steer the model is reported on the turn it happened in', () => {
    const lines = text(
      buildQueueChatLines([
        turn({
          injectionSignals: [
            { kind: 'instruction', detail: 'x', path: 'src/handler.c' },
          ] as never,
        }),
      ]),
    )
    expect(lines).toContain('tried to instruct the model')
    expect(lines).toContain('weigh the answer accordingly')
  })

  test('a turn that is not on record says it will not be there next time', () => {
    expect(text(buildQueueChatLines([turn({ recordedTurnId: null })]))).toContain(
      'this turn is not on record',
    )
    expect(text(buildQueueChatLines([turn()]))).not.toContain('not on record')
  })

  test('the tool calls are counted, so an answer with no reading is visible as one', () => {
    expect(text(buildQueueChatLines([turn({ toolsUsed: ['read_files'] })]))).toContain(
      '[1 tool call: read_files]',
    )
    expect(
      text(buildQueueChatLines([turn({ toolsUsed: ['read_files', 'code_search'] })])),
    ).toContain('[2 tool calls: read_files, code_search]')
    expect(text(buildQueueChatLines([turn()]))).not.toContain('tool call')
  })

  test('turns are separated, and each keeps its own question and answer', () => {
    const lines = text(
      buildQueueChatLines([
        turn({ prompt: 'first?', answer: 'one' }),
        turn({ prompt: 'second?', answer: 'two' }),
      ]),
    )
    const firstQuestion = lines.indexOf('you › first?')
    const firstAnswer = lines.indexOf('one', firstQuestion)
    const secondQuestion = lines.indexOf('you › second?')
    const secondAnswer = lines.indexOf('two', secondQuestion)

    // Each answer sits under its own question rather than being pooled at the end of the pane,
    // which is what a transcript that only concatenated answers would look like.
    expect(firstQuestion).toBeGreaterThanOrEqual(0)
    expect(firstAnswer).toBeGreaterThan(firstQuestion)
    expect(secondQuestion).toBeGreaterThan(firstAnswer)
    expect(secondAnswer).toBeGreaterThan(secondQuestion)
  })
})

describe('describeQueueRefusal', () => {
  test('a conversation that has not been refused has no banner', () => {
    expect(describeQueueRefusal(null)).toBeNull()
  })

  test('a refusal is rendered in the provider\u2019s own words', () => {
    const refusal: ProviderFailure = {
      kind: 'credits',
      detail: 'the account has no credits left',
    }
    expect(describeQueueRefusal(refusal)).toContain('the account has no credits left')
  })
})
