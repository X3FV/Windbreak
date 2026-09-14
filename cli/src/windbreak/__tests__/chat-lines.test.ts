import { describe, expect, test } from 'bun:test'

import {
  buildChatLines,
  CHAT_EXHAUSTED_NOTE,
  describeAgentSwitch,
  describeBudget,
  describeChatAgent,
  describeChatTarget,
  describeProposal,
  parseChatInput,
} from '../chat-lines'

import type { ChatTurn } from '../chat-lines'
import type { ConversationBudgetState } from '@codebuff/windbreak/review'

const turn = (overrides: Partial<ChatTurn> = {}): ChatTurn => ({
  mode: 'explain',
  agent: 'investigator',
  workingCopyId: null,
  writes: [],
  prompt: 'is this real?',
  answer: 'It is a real overflow.',
  error: null,
  toolsUsed: ['read_target_file'],
  proposals: [],
  proposalRejections: [],
  injectionSignals: [],
  recordedTurnId: 'inv_1',
  ...overrides,
})

describe('parseChatInput', () => {
  test('a plain question is about the selection', () => {
    expect(parseChatInput('  what does this do?  ', 'explain')).toEqual({
      mode: 'explain',
      prompt: 'what does this do?',
    })
  })

  test('/hunt switches the job, and the prefix is not part of the question', () => {
    expect(parseChatInput('/hunt find integer overflows', 'explain')).toEqual({
      mode: 'hunt',
      prompt: 'find integer overflows',
    })
  })

  test('and it hunts from a hunt, so the prefix is the mode rather than a toggle', () => {
    // The mode belongs to the question, not to the pane: a researcher who asks about the
    // target and then about a row has changed what they are asking.
    expect(parseChatInput('/hunt again', 'hunt')?.mode).toBe('hunt')
  })

  test('whitespace and a bare prefix send nothing', () => {
    // Each of these would spend a model call to ask nothing.
    expect(parseChatInput('', 'explain')).toBeNull()
    expect(parseChatInput('   ', 'explain')).toBeNull()
    expect(parseChatInput('/hunt', 'explain')).toBeNull()
    expect(parseChatInput('/hunt   ', 'explain')).toBeNull()
  })

  test('/hunting is not the prefix, so it stays a question', () => {
    // No space after `/hunt`, so it is a word rather than the command.
    expect(parseChatInput('/hunting for bugs', 'hunt')).toEqual({
      mode: 'hunt',
      prompt: '/hunting for bugs',
    })
  })
})

describe('buildChatLines', () => {
  test('the empty transcript explains what the pane is for, and what each agent may do', () => {
    const lines = buildChatLines([]).join('\n')
    expect(lines).toContain('/hunt')
    expect(lines).toContain('sandboxed')
    // Both agents named, because a pane that only describes the investigator hides
    // the half of it that writes (§20.30).
    expect(lines).toContain('engineer')
    // The two invariants a researcher needs before trusting anything here: the target
    // is not writable, and neither agent decides.
    expect(lines).toContain('cannot change it')
    expect(lines).toContain('rule on them')
  })

  test('a turn keeps its question and its answer', () => {
    const lines = buildChatLines([turn()])
    expect(lines[0]).toBe('you › is this real?')
    expect(lines.join('\n')).toContain('It is a real overflow.')
  })

  test('a hunt is labelled as one, so the transcript says which job each turn was', () => {
    // §20.29.3: the turn is recorded as a distinct role, and the transcript is where a
    // reader can see which mode a stored answer came from.
    expect(buildChatLines([turn({ mode: 'hunt' })])[0]).toBe('you (hunt) › is this real?')
  })

  test('a pending turn shows no answer at all', () => {
    // Stale text under a running turn would read as the reply to it.
    const lines = buildChatLines([turn({ pending: true, answer: null })])
    expect(lines.join('\n')).toContain('investigating')
    expect(lines.join('\n')).not.toContain('It is a real overflow')
  })

  test('a failed turn is labelled and says no answer rather than looking empty', () => {
    const lines = buildChatLines([
      turn({ answer: null, error: 'the investigator produced no answer', recordedTurnId: null }),
    ]).join('\n')
    expect(lines).toContain('! the investigator produced no answer')
    expect(lines).toContain('not on record')
  })

  test('proposals are shown as candidates that still have to pass the pipeline', () => {
    const lines = buildChatLines([
      turn({
        proposals: [
          {
            filePath: 'src/copy.c',
            startLine: 5,
            endLine: 5,
            cwe: 'CWE-120',
            claim: 'unbounded copy',
          },
        ],
      }),
    ]).join('\n')

    expect(lines).toContain('recorded 1 candidate')
    expect(lines).toContain('src/copy.c:5 (CWE-120)')
    // The sentence that stops a proposal reading as a finding.
    expect(lines).toContain('still have to pass triage and verification')
  })

  test('a refused proposal is shown with its reason', () => {
    const lines = buildChatLines([
      turn({
        proposals: [],
        proposalRejections: [{ requestedPath: 'escape/secret.txt', reason: 'outside the target' }],
      }),
    ]).join('\n')

    expect(lines).toContain('refused escape/secret.txt: outside the target')
  })

  test('a turn whose tool results were hostile is marked, with the kinds', () => {
    // §5.1 reaches the screen: the reader is being asked to weigh reasoning that a
    // hostile file tried to steer.
    const lines = buildChatLines([
      turn({
        injectionSignals: [
          { kind: 'instruction-override', evidence: 'ignore all previous', line: 1 },
          { kind: 'instruction-override', evidence: 'ignore all previous', line: 3 },
        ],
      }),
    ]).join('\n')

    expect(lines).toContain('tried to instruct the model (instruction-override)')
    expect(lines).toContain('weigh the answer accordingly')
    // Deduplicated, so one file with two attempts is one notice.
    expect(lines.match(/instruction-override/g)).toHaveLength(1)
  })

  test('turns are separated so the second question cannot read as part of the first answer', () => {
    const lines = buildChatLines([turn(), turn({ prompt: 'and here?' })])
    expect(lines.join('\n')).toContain('\n\nyou › and here?')
  })
})

describe('describeProposal', () => {
  test('a single line is one location and a range is two', () => {
    expect(
      describeProposal({ filePath: 'a.c', startLine: 4, endLine: 4, cwe: null, claim: 'c' }),
    ).toBe('a.c:4')
    expect(
      describeProposal({ filePath: 'a.c', startLine: 4, endLine: 9, cwe: null, claim: 'c' }),
    ).toBe('a.c:4-9')
  })

  test('a CWE is shown only when the model gave one', () => {
    expect(
      describeProposal({ filePath: 'a.c', startLine: 1, endLine: 1, cwe: 'CWE-787', claim: 'c' }),
    ).toBe('a.c:1 (CWE-787)')
  })
})

describe('describeBudget (§20.29.6)', () => {
  const budget = (overrides: Partial<ConversationBudgetState> = {}): ConversationBudgetState => ({
    calls: 12,
    limit: 120,
    turns: 3,
    tokens: 0,
    exhausted: false,
    remaining: 108,
    ...overrides,
  })

  test('it shows spent and ceiling together, so the line says both things', () => {
    // `used/limit` and not "n left": a remaining count alone cannot say whether the
    // conversation is nearly over or barely begun.
    const line = describeBudget(budget())
    expect(line).toContain('12/120')
    expect(line).toContain('3 turns')
  })

  test('a spent ceiling says so rather than reading as a normal count', () => {
    const line = describeBudget(budget({ calls: 120, exhausted: true, remaining: 0 }))
    expect(line).toContain('spent')
    expect(line).toContain('120/120')
  })

  test('tokens are shown only when the provider reported them', () => {
    expect(describeBudget(budget({ tokens: 12_400 }))).toContain('12.4k tokens')
    expect(describeBudget(budget({ tokens: 0 }))).not.toContain('tokens')
  })

  test('the first turn reads as no turns yet rather than as zero turns', () => {
    expect(describeBudget(budget({ calls: 0, turns: 0 }))).toContain('no turns yet')
  })

  test('no budget is no line, not a wrong one', () => {
    expect(describeBudget(null)).toBe('')
  })

  test('the exhausted note names the way out', () => {
    // A ceiling with no stated exit is just a broken pane.
    expect(CHAT_EXHAUSTED_NOTE).toContain('esc')
  })
})

describe('a cancelled turn (§20.29.5 slice 6)', () => {
  test('it is marked as stopped, not shown as a failure', () => {
    // "You stopped it" and "it broke" are different facts, and a pane that renders them
    // the same is §18 in the transcript.
    const lines = buildChatLines([
      turn({ answer: null, error: 'the turn was cancelled before it finished', cancelled: true }),
    ]).join('\n')
    expect(lines).toContain('cancelled')
    expect(lines).toContain('you stopped this turn')
    expect(lines).not.toContain('the turn was cancelled before it finished')
  })

  test('a pending turn says how to stop it', () => {
    const lines = buildChatLines([turn({ pending: true, answer: null })]).join('\n')
    expect(lines).toContain('esc stops it')
  })
})

describe('describeChatTarget', () => {
  test('it names the row the next question will be about', () => {
    expect(describeChatTarget('explain', { filePath: 'src/a.c', startLine: 12 })).toBe(
      'next question asks about src/a.c:12',
    )
  })

  test('with nothing selected it says the next question hunts', () => {
    // Which is true, because `modeFor` falls back to `hunt` — saying so is what stops the
    // same input meaning two things with no cue.
    expect(describeChatTarget('hunt', null)).toContain('/hunt')
    expect(describeChatTarget('explain', { filePath: null, startLine: null })).toContain(
      'hunts the target',
    )
  })
})

describe('the two agents (§20.30)', () => {
  test('an engineer turn is labelled and an investigator turn is not', () => {
    // The label is a qualifier on the common case, not a prefix on every line: a
    // transcript where every question carries a role word stops being read.
    expect(buildChatLines([turn()])[0]).toBe('you › is this real?')
    expect(buildChatLines([turn({ agent: 'engineer' })])[0]).toBe(
      'you (engineer) › is this real?',
    )
  })

  test('a hunt by the engineer names both', () => {
    expect(buildChatLines([turn({ agent: 'engineer', mode: 'hunt' })])[0]).toBe(
      'you (engineer, hunt) › is this real?',
    )
    expect(buildChatLines([turn({ mode: 'hunt' })])[0]).toBe('you (hunt) › is this real?')
  })

  test('a write is reported as files, with what happened to them', () => {
    const lines = buildChatLines([
      turn({
        agent: 'engineer',
        workingCopyId: 'wcopy_1',
        writes: [
          {
            tool: 'apply_patch_in_copy',
            path: 'src/parse.c',
            action: 'update',
            bytes: 120,
            inserted: 1,
            removed: 1,
          },
          { tool: 'write_copy_file', path: 'poc/trigger.c', action: 'create', bytes: 40, inserted: 0, removed: 0 },
        ],
      }),
    ]).join('\n')

    expect(lines).toContain('edited 2 files in the working copy')
    expect(lines).toContain('update src/parse.c (+1/-1)')
    expect(lines).toContain('create poc/trigger.c')
    // The claim the whole design rests on: the edit is in a copy.
    expect(lines).toContain('the target is unchanged')
  })

  test('a turn that wrote nothing says nothing about writes', () => {
    expect(buildChatLines([turn()]).join('\n')).not.toContain('working copy')
  })

  test('describeChatAgent names the root, and is honest before the copy exists', () => {
    expect(describeChatAgent('investigator', null)).toContain('cannot change it')
    expect(describeChatAgent('engineer', null)).toContain('made on the first turn')
    expect(
      describeChatAgent('engineer', {
        id: 'wcopy_1',
        root: '/repo/.windbreak/scratch/investigator/working-copy',
        baseCommit: 'abc123',
        files: 42,
        bytes: 2048,
        createdAt: '2026-09-13T00:00:00.000Z',
      }),
    ).toContain('42 files')
  })

  test('the switch hint names the destination, not the key', () => {
    // A hint that said "switch agent" while `tab` always went the same way would be a
    // false label on the pane's own chrome.
    expect(describeAgentSwitch('investigator')).toBe('tab engineer')
    expect(describeAgentSwitch('engineer')).toBe('tab investigator')
  })
})
