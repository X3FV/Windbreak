import { describe, expect, test } from 'bun:test'

import {
  candidateLocation,
  queueClosingLine,
  queueDetailLines,
  queueHeaderLines,
  queueListLines,
  queueNoticeLines,
  queuePlaceholderLines,
  QUEUE_LABEL_WIDTH,
  shortCandidateId,
} from '../queue-content'

import type { ReviewDecision, ReviewEntryDetail, ReviewQueueSource } from '@codebuff/windbreak/review'
import type { QueueLine } from '../queue-content'

/**
 * Every word the lines carry, in order, run together as prose.
 *
 * Joined with a space rather than a newline because a sentence in this pane is several lines: the
 * copy is wrapped by hand so it reads well on a narrow terminal, and an assertion that had to
 * guess where the breaks fall would be testing the wrap instead of the wording.
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

const detail = (overrides: Partial<ReviewEntryDetail> = {}): ReviewEntryDetail => ({
  summary: {
    candidateId: 'cand-1',
    runId: 'run-1',
    filePath: 'src/handler.c',
    startLine: 6,
    cwe: 'CWE-120',
    source: 'semgrep',
    patternId: 'wb-c-unbounded-string-op',
    decision: null,
    decidedAt: null,
    rationale: null,
  },
  candidateState: 'escalated',
  target: {
    id: 't1',
    location: '/home/researcher/project-a',
    buildModel: 'compile_commands',
    scopeClass: 'userspace-c',
    commitSha: 'abc123def456',
  },
  evidence: {
    engine: 'semgrep',
    ruleId: 'wb-c-unbounded-string-op',
    message: 'unbounded copy into a fixed-size buffer',
    level: 'error',
    filePath: 'src/handler.c',
    startLine: 6,
    endLine: 6,
    snippet: '  strcpy(buf, line);',
    injectionSignals: ['IGNORE ALL PREVIOUS INSTRUCTIONS'],
  },
  proposer: {
    role: 'proposer',
    verdictId: 'ver-proposer',
    verdict: 'real',
    reasoning: 'the length check happens after the copy',
    preconditions: ['line comes from an untrusted caller'],
    modelId: 'openai/gpt-5',
    provider: 'openai',
  },
  refuter: {
    role: 'refuter',
    verdictId: 'ver-refuter',
    verdict: 'benign',
    reasoning: 'callers validate the length upstream',
    preconditions: [],
    modelId: 'z-ai/glm-5.3',
    provider: 'z-ai',
  },
  ...overrides,
})

const source = (overrides: Partial<ReviewQueueSource> = {}): ReviewQueueSource => ({
  path: '/repo/.windbreak/state.db',
  absent: false,
  ...overrides,
})

describe('the header names the subject before anything else', () => {
  test('the repository, the database, and the queue it read', () => {
    const lines = text(
      queueHeaderLines({
        repoRoot: '/repo',
        source: source(),
        counts: { total: 4, pending: 3, resolved: 1 },
        includeResolved: false,
        refusal: null,
      }),
    )

    expect(lines).toContain('/repo')
    expect(lines).toContain('/repo/.windbreak/state.db')
    expect(lines).toContain('3 pending · 1 of 4 decided')
    expect(lines).toContain('pending only')
  })

  test('a refusal names the file it is about, and never reports an empty queue', () => {
    const lines = text(
      queueHeaderLines({
        repoRoot: '/repo',
        refusal: 'schema version 3 does not match the expected 8',
        dbPath: '/repo/.windbreak/state.db',
        source: null,
        counts: null,
        includeResolved: false,
      }),
    )

    expect(lines).toContain('/repo/.windbreak/state.db')
    // Not `0 pending`, which is a number this screen has no basis for (§18).
    expect(lines).toContain('not read')
    expect(lines).not.toContain('0 pending')
  })

  test('a refusal with no database to name blames the configuration', () => {
    const lines = text(
      queueHeaderLines({
        repoRoot: '/repo',
        refusal: 'could not read /repo/.windbreak/config.json',
        dbPath: null,
        source: null,
        counts: null,
        includeResolved: false,
      }),
    )

    expect(lines).toContain('not resolved — the configuration could not be read')
    expect(lines).toContain('not read')
  })

  test('a missing database says so where the count would be', () => {
    const lines = text(
      queueHeaderLines({
        repoRoot: '/repo',
        source: source({ absent: true }),
        counts: { total: 0, pending: 0, resolved: 0 },
        includeResolved: false,
        refusal: null,
      }),
    )

    expect(lines).toContain('nothing here')
    expect(lines).not.toContain('0 pending · 0 of 0 decided')
  })
})

describe('the placeholder tells four different nothings apart', () => {
  test('a refusal says nothing was read, not that nothing was found', () => {
    const lines = text(
      queuePlaceholderLines({
        refusal: 'could not open /repo/.windbreak/state.db: version mismatch',
        source: null,
        counts: null,
        includeResolved: false,
      }),
    )

    expect(lines).toContain('The queue was not opened.')
    expect(lines).toContain('version mismatch')
    expect(lines).toContain('This is not an empty queue')
  })

  test('a missing database is the §18 substitution, named', () => {
    const lines = text(
      queuePlaceholderLines({
        refusal: null,
        source: source({ absent: true }),
        counts: { total: 0, pending: 0, resolved: 0 },
        includeResolved: false,
      }),
    )

    expect(lines).toContain('No state database exists at /repo/.windbreak/state.db.')
    expect(lines).toContain('different facts')
    expect(lines).toContain('nothing has been scanned into this path')
  })

  test('an empty queue is a statement about disagreements, not about the code', () => {
    const lines = text(
      queuePlaceholderLines({
        refusal: null,
        source: source(),
        counts: { total: 0, pending: 0, resolved: 0 },
        includeResolved: false,
      }),
    )

    expect(lines).toContain('This database holds no disagreements.')
    expect(lines).toContain('an empty queue is a statement about disagreements, not about the code')
    expect(lines).toContain('a scan that never ran look the same from here')
  })

  test('a fully decided queue points at the rows rather than looking empty', () => {
    const lines = text(
      queuePlaceholderLines({
        refusal: null,
        source: source(),
        counts: { total: 2, pending: 0, resolved: 2 },
        includeResolved: false,
      }),
    )

    expect(lines).toContain('Every disagreement in this database has been decided: 2 of 2.')
    expect(lines).toContain('Press `a` to list them')
  })
})

describe('list rows', () => {
  test('carry the id, the location, the class and the decision', () => {
    const lines = queueListLines(
      [
        {
          candidateId: 'cand-1',
          runId: 'run-1',
          filePath: 'src/handler.c',
          startLine: 6,
          cwe: 'CWE-120',
          source: 'semgrep',
          patternId: 'wb-c-unbounded-string-op',
          decision: null,
          decidedAt: null,
          rationale: null,
        },
        {
          candidateId: 'cand-2-with-a-long-identifier',
          runId: 'run-1',
          filePath: null,
          startLine: null,
          cwe: null,
          source: 'toctou',
          patternId: null,
          decision: 'benign',
          decidedAt: '2026-02-02T00:00:00Z',
          rationale: 'checked the callers',
        },
      ],
      0,
    )

    expect(text(lines)).toContain('❯ cand-1')
    expect(text(lines)).toContain('src/handler.c:6')
    expect(text(lines)).toContain('CWE-120')
    expect(text(lines)).toContain('benign 2026-02-02')
    // A location that is not on record says so; it is not rendered as an empty column.
    expect(text(lines)).toContain('(no file recorded)')
    expect(lines[0]!.tone).toBe('info')
    expect(lines[1]!.tone).toBe('muted')
  })
})

describe('the detail pane', () => {
  test('shows both arguments in full, with the model and the provider behind each', () => {
    const lines = text(queueDetailLines(detail()))

    // The disagreement itself.
    expect(lines).toContain('the length check happens after the copy')
    expect(lines).toContain('callers validate the length upstream')
    expect(lines).toContain('openai/gpt-5 via openai')
    expect(lines).toContain('z-ai/glm-5.3 via z-ai')
    expect(lines).toContain('said real')
    expect(lines).toContain('said benign')
    // §5.2's conditions.
    expect(lines).toContain('line comes from an untrusted caller')
  })

  test('shows the evidence, the snippet, and the injection signals as evidence', () => {
    const lines = text(queueDetailLines(detail()))

    expect(lines).toContain('semgrep · wb-c-unbounded-string-op')
    expect(lines).toContain('unbounded copy into a fixed-size buffer')
    expect(lines).toContain('src/handler.c:6–6')
    expect(lines).toContain('strcpy(buf, line);')
    expect(lines).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS')
    expect(lines).toContain('an attempt to steer a model is evidence about the')
  })

  test('an unreadable evidence bundle is not a finding with no evidence', () => {
    const lines = text(queueDetailLines(detail({ evidence: null })))

    expect(lines).toContain('could not be read from the database')
    expect(lines).toContain('not')
    expect(lines).toContain('a statement about the code')
  })

  test('a side whose verdict record is gone says the record was removed', () => {
    const lines = text(queueDetailLines(detail({ refuter: null })))

    expect(lines).toContain('refuter’s verdict record is missing')
    expect(lines).toContain('a record that was removed rather than a model that said nothing')
  })

  test('a resolved row shows the decision, when it was made, and the rationale', () => {
    const lines = text(
      queueDetailLines(
        detail({
          summary: {
            ...detail().summary,
            decision: 'benign' as ReviewDecision,
            decidedAt: '2026-02-02T00:00:00Z',
            rationale: 'checked the callers by hand',
          },
        }),
      ),
    )

    expect(lines).toContain('benign')
    expect(lines).toContain('dropped from verification')
    expect(lines).toContain('2026-02-02T00:00:00Z')
    expect(lines).toContain('checked the callers by hand')
  })

  test('a decision with no rationale says the decision stands without one', () => {
    const lines = text(
      queueDetailLines(
        detail({
          summary: {
            ...detail().summary,
            decision: 'real' as ReviewDecision,
            decidedAt: '2026-02-02T00:00:00Z',
            rationale: null,
          },
        }),
      ),
    )

    expect(lines).toContain('none recorded — the decision stands without one')
  })

  test('an unresolved row has no decision section at all', () => {
    const lines = text(queueDetailLines(detail()))
    expect(lines).not.toContain('your decision')
  })
})

describe('the line the transcript keeps', () => {
  test('a refusal keeps the reason rather than a count', () => {
    const line = queueClosingLine({
      refusal: 'could not read /repo/.windbreak/config.json: unexpected end of JSON',
      source: null,
      counts: null,
      decided: [],
    })

    expect(line).toContain('not opened')
    expect(line).toContain('unexpected end of JSON')
    expect(line).not.toContain('0 pending')
  })

  test('a missing database is named', () => {
    const line = queueClosingLine({
      refusal: null,
      source: source({ absent: true }),
      counts: { total: 0, pending: 0, resolved: 0 },
      decided: [],
    })

    expect(line).toContain('no database at /repo/.windbreak/state.db')
  })

  test('the decisions made in the view are the part worth keeping', () => {
    const line = queueClosingLine({
      refusal: null,
      source: source(),
      counts: { total: 4, pending: 1, resolved: 3 },
      decided: ['real', 'benign', 'real'],
    })

    expect(line).toContain('1 pending')
    expect(line).toContain('3 of 4 decided')
    expect(line).toContain('decided here: real ×2, benign ×1')
  })

  test('a visit that decided nothing says so', () => {
    const line = queueClosingLine({
      refusal: null,
      source: source(),
      counts: { total: 2, pending: 2, resolved: 0 },
      decided: [],
    })

    expect(line).toContain('nothing was decided in this view')
  })
})

describe('the confirmation after a decision', () => {
  test('names the decision and what it does downstream', () => {
    const lines = text(
      queueNoticeLines({ candidateId: 'cand-1', decision: 'real', previous: null }),
    )

    expect(lines).toContain('recorded real for cand-1')
    expect(lines).toContain('joins verification as confirmed')
  })

  test('a second look is announced rather than silent', () => {
    const lines = queueNoticeLines({ candidateId: 'cand-1', decision: 'real', previous: 'benign' })
    const rendered = text(lines)

    expect(rendered).toContain('This replaces an earlier benign')
    expect(lines[0]!.tone).toBe('warning')
  })
})

describe('the small formatters', () => {
  test('a candidate id is shortened only when it has to be, and the detail keeps it whole', () => {
    expect(shortCandidateId('cand-1')).toBe('cand-1')
    expect(shortCandidateId('cand-2-with-a-long-identifier')).toBe('cand-2-with-a…')
  })

  test('a location is file:line, or the file, or a stated absence', () => {
    expect(candidateLocation({ filePath: 'src/a.c', startLine: 3 })).toBe('src/a.c:3')
    expect(candidateLocation({ filePath: 'src/a.c', startLine: null })).toBe('src/a.c')
    expect(candidateLocation({ filePath: null, startLine: null })).toBe('(no file recorded)')
  })

  test('the label column is wide enough for the longest label the detail uses', () => {
    const labels = queueDetailLines(detail())
      .filter((line): line is Extract<QueueLine, { kind: 'field' }> => line.kind === 'field')
      .map((line) => line.label)
    for (const label of labels) {
      expect(label.length).toBeLessThanOrEqual(QUEUE_LABEL_WIDTH)
    }
  })
})
