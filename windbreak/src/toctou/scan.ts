/**
 * Sweeping the program model for check-to-use defects (spec §4.4.3, part 3).
 *
 * §4.4.3 asks for candidate code paths to be "validated against" the four FSMs,
 * with alias analysis on locks and on the checked/used variables. This module is
 * that validation, and it runs three producers over the same function set:
 *
 * 1. **The four FSMs**, over each function's event stream (`events.ts` + `fsm.ts`).
 * 2. **The mined atomicity rules**, checked as "is this resource ever touched with
 *    its lock not held" (`rules.ts`).
 * 3. **The four signal-handler shapes** (CWE-364), over the functions a *registration*
 *    identifies as handlers (`handlers.ts` + `signal.ts`).
 *
 * They share the sweep because they share everything that matters operationally:
 * the same regions from the program model, the same source cache, the same cap
 * discipline, the same file/function provenance. Splitting them into two sweeps
 * would mean two passes over the same `symbols` table for no gain.
 *
 * ## The signal producer is the one that needs a pre-pass, and that is the weakness
 *
 * The first two producers are functions of one region. The third is not: "is this a
 * handler" and "who else touches this object" are facts about the whole program, so
 * they are collected once, before the sweep, by `buildSignalPrePass`. That turns the
 * sweep into two walks and the cost is real — the pre-pass reads every indexed
 * function's source, and unlike the producers it is *not* bounded by the site caps,
 * because a cap limits findings and the pre-pass is what makes findings possible.
 * Recorded in §20.23. `--no-signal` exists so the cost can be declined.
 *
 * ## Regions come from the program model, not a line window
 *
 * Same reasoning as `patchmine/siblings.ts`, and the stakes are higher here: the
 * alias relation is built from `local = expr` assignments *within a function*, so a
 * region that is not a function would make copy propagation cross a function
 * boundary and alias a local to an unrelated one. The FSMs also depend on the
 * region because the held-lock set is per-function — a lock held in a caller is
 * invisible, which is a real recall cost and the right precision call.
 *
 * ## Caps are per producer, and reported
 *
 * A `path-check-then-use` sweep over a filesystem-heavy target will match a lot of
 * functions; that is the shape's nature, not a bug. Each producer gets its own cap
 * and each cap is reported as `capped`, so a truncated sweep cannot be read as a
 * complete one — the same discipline §20.21 applied to the patch-mined sweep.
 */

import { languageFilterSql } from '../detectors/capability'
import { SourceCache } from '../engines/normalize'
import { CALLABLE_KIND_FILTER } from '../recon/symbol-kinds'
import { aliases, buildBindings } from './alias'
import { describeFsmFinding, describeSignalFinding, describeViolation } from './describe'
import { accessedExpressions, bodyStartIndex, extractEvents } from './events'
import { runFsm } from './fsm'
import { findSignalHandlers } from './handlers'
import {
  fileScopeDeclarations,
  globalTouches,
  masksSignals,
  runSignalShapes,
  signalFindingCheckLine,
  signalFindingLine,
} from './signal'
import { SIGNAL_SHAPES, TOCTOU_FSMS, handlerKey, signalProducer } from './types'

import type { Database } from 'bun:sqlite'
import type { DetectorId } from '../detectors/capability'
import type { Bindings } from './alias'
import type {
  AtomicEvent,
  FileScopeDeclarations,
  RuleViolation,
  SignalHandler,
  SignalOtherLocation,
  SignalShape,
  ToctouCoverage,
  ToctouFsm,
  ToctouSite,
  ToctouSweepOutcome,
} from './types'
import type { AtomicityRule } from './types'

export const DEFAULT_MAX_SITES_PER_PRODUCER = 40

interface FunctionRow {
  file_path: string
  name: string
  start_line: number
  end_line: number
}

export interface SweepOptions {
  db: Database
  targetId: string
  targetRoot: string
  rules: readonly AtomicityRule[]
  /** Which FSMs to run. Defaults to all four. */
  fsms?: readonly ToctouFsm[]
  /**
   * Run the CWE-364 signal-handler producer. Default true.
   *
   * Off is a real option rather than a debugging aid: the producer's pre-pass reads
   * every indexed function, which is the most expensive thing the static core does,
   * and a target with no signal handling at all gains nothing from it.
   */
  signalHandlers?: boolean
  sourceCache?: SourceCache
  /** Cap per FSM, per rule, and per signal shape. */
  maxSitesPerProducer?: number
  log?: (line: string) => void
}

export interface SweepResult {
  sites: ToctouSite[]
  outcomes: ToctouSweepOutcome[]
  coverage: ToctouCoverage
  warnings: string[]
}

/** One function's region, as the pre-pass and the sweep both need to see it. */
interface SignalRegion {
  filePath: string
  name: string
  startLine: number
  lines: readonly string[]
}

/**
 * The cross-function facts the signal producer cannot compute from one region.
 *
 * `touches` deliberately keeps *every* function's access, including the handler's
 * own, and the self-exclusion happens where the analysis runs. Excluding it here
 * would be wrong for the case MITRE lists separately — one handler sharing state with
 * another — because which function is "self" depends on which handler is being
 * analysed.
 */
export interface SignalPrePass {
  handlers: ReadonlyMap<string, SignalHandler>
  /** Object name → every function that touches it, in `(file, line)` order. */
  touches: ReadonlyMap<string, SignalOtherLocation[]>
  /** Distinct non-`sig_atomic_t` objects touched inside a handler. */
  sharedKeys: ReadonlySet<string>
  unresolved: string[]
  ambiguous: string[]
  /** File-scope declarations per file, memoised — the sweep needs the same set. */
  scopeOf: (filePath: string) => FileScopeDeclarations
}

/**
 * Collect what the signal producer needs from the whole program.
 *
 * Two walks over the same function list, because resolution has to be complete before
 * any name can be placed: handlers are identified from *registrations* (which live in
 * some function) and then looked up against *definitions* (which live in another).
 *
 * The signal-mask veto is applied here rather than in `signal.ts`, and applied to the
 * *touching* function rather than to the handler: a function that blocks delivery
 * cannot be interrupted, so it is neither racy in itself nor a race partner for
 * anything else. Getting that direction backwards would veto the whole shape, since a
 * handler that masks signals is still racing with the code that does not.
 */
export const buildSignalPrePass = (input: {
  functions: readonly FunctionRow[]
  sourceCache: SourceCache
}): SignalPrePass => {
  const regions: SignalRegion[] = []
  const masked = new Set<string>()

  for (const fn of input.functions) {
    const lines = input.sourceCache.lines(fn.file_path)
    if (lines === null) continue
    const from = Math.max(0, fn.start_line - 1)
    const to = Math.min(lines.length, fn.end_line)
    if (to <= from) continue

    const region = lines.slice(from, to)
    regions.push({ filePath: fn.file_path, name: fn.name, startLine: fn.start_line, lines: region })
    if (masksSignals(region)) masked.add(handlerKey(fn.file_path, fn.name))
  }

  const index = findSignalHandlers(regions)

  const scopes = new Map<string, FileScopeDeclarations>()
  const scopeOf = (filePath: string): FileScopeDeclarations => {
    const cached = scopes.get(filePath)
    if (cached !== undefined) return cached
    const scope = fileScopeDeclarations(input.sourceCache.lines(filePath) ?? [])
    scopes.set(filePath, scope)
    return scope
  }

  const touches = new Map<string, SignalOtherLocation[]>()
  const sharedKeys = new Set<string>()

  for (const region of regions) {
    const self = handlerKey(region.filePath, region.name)
    if (masked.has(self)) continue

    const scope = scopeOf(region.filePath)
    if (scope.globals.size === 0) continue

    const isHandler = index.handlers.has(self)

    for (const touch of globalTouches({ lines: region.lines, scope })) {
      // The documented fix is `sig_atomic_t`; counting it as shared state would make
      // the coverage number describe the cure as if it were the disease.
      if (isHandler && !scope.sigAtomic.has(touch.key)) sharedKeys.add(touch.key)

      const list = touches.get(touch.key) ?? []
      list.push({
        filePath: region.filePath,
        functionName: region.name,
        fileLine: region.startLine + touch.line - 1,
        written: touch.wrote,
        isHandler,
      })
      touches.set(touch.key, list)
    }
  }

  return {
    handlers: index.handlers,
    touches,
    sharedKeys,
    unresolved: index.unresolved,
    ambiguous: index.ambiguous,
    scopeOf,
  }
}

/**
 * The lock-held intervals a rule's lock establishes in one function.
 *
 * Intervals rather than a boolean, because the question a rule asks is *where* the
 * lock was held: an access between the acquire and its release is protected, and an
 * access after the release — or before the acquire — is not. A boolean would report
 * a use before the lock as protected.
 *
 * An unmatched acquire (no release in the function) ends the interval at the end of
 * the function. That is the conservative reading: the lock is treated as held for
 * the rest of the body, so a use inside it is *not* reported. Under-reporting here
 * is deliberate — a `return` that skips the release is a resource leak, which is a
 * different defect than the one this module is about.
 */
const lockIntervals = (
  events: readonly AtomicEvent[],
  lock: string,
  bindings: Bindings,
  lastLine: number,
): Array<{ from: number; to: number }> => {
  const intervals: Array<{ from: number; to: number }> = []
  let openedAt: number | null = null

  for (const event of events) {
    if (event.kind === 'lock' && aliases(event.key, lock, bindings)) {
      if (openedAt === null) openedAt = event.line
      continue
    }
    if (event.kind === 'unlock' && aliases(event.key, lock, bindings)) {
      if (openedAt !== null) {
        intervals.push({ from: openedAt, to: event.line })
        openedAt = null
      }
    }
  }

  if (openedAt !== null) intervals.push({ from: openedAt, to: lastLine })
  return intervals
}

/** Whether a line falls inside any of the intervals. */
const covered = (line: number, intervals: ReadonlyArray<{ from: number; to: number }>): boolean =>
  intervals.some((interval) => line >= interval.from && line <= interval.to)

/**
 * Rule violations in one function body.
 *
 * Precision rests on two things, both of them the module's existing instruments:
 * `aliases` decides that the accessed expression is the resource the rule is about
 * (so `s->count` in a function whose `s` is a different local than the mined one is
 * a known recall/precision limit, recorded in the module note), and `lockIntervals`
 * decides whether the lock was held *at that line*.
 */
export const ruleViolations = (input: {
  lines: readonly string[]
  rules: readonly AtomicityRule[]
  bindings: Bindings
  events: readonly AtomicEvent[]
}): RuleViolation[] => {
  const { lines, rules, bindings, events } = input
  const accesses = accessedExpressions(lines, bodyStartIndex(lines) + 1)
  const violations: RuleViolation[] = []

  for (const rule of rules) {
    const intervals = lockIntervals(events, rule.lock, bindings, lines.length)
    const seen = new Set<string>()

    for (const access of accesses) {
      if (!aliases(access.key, rule.resource, bindings)) continue
      if (covered(access.line, intervals)) continue

      const key = bindings.resolve(access.key)
      if (seen.has(key)) continue
      seen.add(key)

      violations.push({
        line: access.line,
        resource: key,
        lock: rule.lock,
        // The distinction the sentence needs: a mis-scoped lock is a different fix
        // from a missing one.
        heldElsewhere: intervals.length > 0,
      })
    }
  }

  return violations
}

/**
 * Sweep every indexed function with both producers.
 *
 * A missing program model is a *missing input*, not an empty result: the warning
 * says so rather than returning an empty site list that reads as "clean" (the same
 * distinction `patchmine/siblings.ts` draws).
 */
export const sweepFunctions = (options: SweepOptions): SweepResult => {
  const log = options.log ?? (() => {})
  const warnings: string[] = []
  const maxSites = options.maxSitesPerProducer ?? DEFAULT_MAX_SITES_PER_PRODUCER
  const fsms = options.fsms ?? TOCTOU_FSMS
  const sourceCache = options.sourceCache ?? new SourceCache(options.targetRoot)
  const signalEnabled = options.signalHandlers !== false
  const signalShapes: readonly SignalShape[] = signalEnabled ? SIGNAL_SHAPES : []

  // The detectors this sweep actually runs, so the language filter is theirs. The
  // signal machine drops out when it is disabled rather than the filter claiming
  // coverage a detector that is not running is not providing — the matrix is a
  // statement about what ran, not about what exists.
  const activeDetectors: DetectorId[] = ['toctou']
  if (signalEnabled) activeDetectors.push('signal-handler')
  const languageFilter = languageFilterSql(activeDetectors)

  const coverage: ToctouCoverage = {
    commitsRead: 0,
    hunksAddingLock: 0,
    hunksWithoutResource: 0,
    functionsSwept: 0,
    functionsWithEvents: 0,
    signalHandlers: 0,
    sharedKeys: 0,
    noDetectorTables: 0,
  }

  // Counted before the filter is applied, so the report can say how much of the
  // program model the C-shaped tables did not reach. A `WHERE` that quietly
  // excluded 90% of a Python repository would make the candidate list short for
  // a reason nobody could see.
  coverage.noDetectorTables =
    options.db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM symbols
          WHERE target_id = ? AND ${CALLABLE_KIND_FILTER}
            AND NOT (${languageFilter})`,
      )
      .get(options.targetId)?.count ?? 0

  const functions = options.db
    .query<FunctionRow, [string]>(
      `SELECT file_path, name, start_line, end_line
         FROM symbols
        WHERE target_id = ? AND ${CALLABLE_KIND_FILTER}
          AND ${languageFilter}
        ORDER BY file_path, start_line`,
    )
    .all(options.targetId)

  if (functions.length === 0) {
    warnings.push(
      'No indexed functions for this target, so no check-to-use patterns could be ' +
        'validated. Run recon first.',
    )
    return {
      sites: [],
      outcomes: [
        ...fsms.map((fsm) => ({ producer: `fsm:${fsm}`, sites: 0, capped: false })),
        ...options.rules.map((rule) => ({
          producer: `rule:${rule.id}`,
          sites: 0,
          capped: false,
        })),
        ...signalShapes.map((shape) => ({ producer: signalProducer(shape), sites: 0, capped: false })),
      ],
      coverage,
      warnings,
    }
  }

  const fsmSites = new Map<ToctouFsm, number>(fsms.map((fsm) => [fsm, 0]))
  const fsmCapped = new Map<ToctouFsm, boolean>(fsms.map((fsm) => [fsm, false]))
  const ruleSites = new Map<string, number>(options.rules.map((rule) => [rule.id, 0]))
  const ruleCapped = new Map<string, boolean>(options.rules.map((rule) => [rule.id, false]))
  const signalSiteCount = new Map<SignalShape, number>(signalShapes.map((shape) => [shape, 0]))
  const signalCapped = new Map<SignalShape, boolean>(signalShapes.map((shape) => [shape, false]))

  // The pre-pass is where the signal producer's cost is, so it only runs when the
  // producer is on. Its result is null rather than empty so a disabled producer and a
  // target with no handlers are distinguishable in the output.
  let prePass: SignalPrePass | null = null
  if (signalEnabled) {
    prePass = buildSignalPrePass({ functions, sourceCache })
    coverage.signalHandlers = prePass.handlers.size
    coverage.sharedKeys = prePass.sharedKeys.size
    log(
      `[toctou] signal pre-pass: ${prePass.handlers.size} handler(s), ` +
        `${prePass.sharedKeys.size} shared object(s)`,
    )
    for (const name of prePass.unresolved) {
      warnings.push(
        `Signal registration names \`${name}\`, which the program model does not have; ` +
          'the registration was skipped rather than guessed at.',
      )
    }
    for (const name of prePass.ambiguous) {
      warnings.push(
        `Signal registration is ambiguous: \`${name}\`. A same-file definition wins; ` +
          'with none, the registration is dropped rather than attached to the wrong function.',
      )
    }
  }

  const sites: ToctouSite[] = []

  for (const fn of functions) {
    coverage.functionsSwept += 1

    // Every producer is capped and the sweep is over: stopping entirely rather than
    // finishing the walk is what makes the cap a bound on work rather than a bound
    // on output.
    const allCapped =
      fsms.every((fsm) => (fsmSites.get(fsm) ?? 0) >= maxSites) &&
      options.rules.every((rule) => (ruleSites.get(rule.id) ?? 0) >= maxSites) &&
      signalShapes.every((shape) => (signalSiteCount.get(shape) ?? 0) >= maxSites)
    if (allCapped) {
      // Stopping entirely leaves this and every later function unexamined, so each
      // producer that was at its cap is partial even though nothing was dropped from
      // the site list.
      for (const fsm of fsms) fsmCapped.set(fsm, true)
      for (const rule of options.rules) ruleCapped.set(rule.id, true)
      for (const shape of signalShapes) signalCapped.set(shape, true)
      break
    }

    const lines = sourceCache.lines(fn.file_path)
    if (lines === null) continue

    const from = Math.max(0, fn.start_line - 1)
    const to = Math.min(lines.length, fn.end_line)
    if (to <= from) continue

    const region = lines.slice(from, to)
    const events = extractEvents(region)
    if (events.length > 0) coverage.functionsWithEvents += 1

    const bindings = buildBindings(region)

    // The line a region-relative line number maps to in the file. `symbols`
    // start/end are 1-based inclusive from tree-sitter, which is what the
    // detectors translate through.
    const toFileLine = (regionLine: number): number => fn.start_line + regionLine - 1

    for (const fsm of fsms) {
      if ((fsmSites.get(fsm) ?? 0) >= maxSites) {
        // This function was never examined by this producer. Marking the cap here
        // rather than only at the inner `break` is the difference between a
        // truncated sweep and one that reads as complete: the skip happens *before*
        // any finding exists to break on.
        fsmCapped.set(fsm, true)
        continue
      }
      const findings = runFsm(fsm, events, bindings)

      for (const finding of findings) {
        if ((fsmSites.get(fsm) ?? 0) >= maxSites) {
          fsmCapped.set(fsm, true)
          break
        }
        fsmSites.set(fsm, (fsmSites.get(fsm) ?? 0) + 1)
        sites.push({
          kind: 'fsm',
          fsm,
          ruleId: null,
          filePath: fn.file_path,
          functionName: fn.name,
          startLine: fn.start_line,
          endLine: fn.end_line,
          matchLine: toFileLine(finding.useLine),
          checkLine: toFileLine(finding.checkLine),
          resource: finding.resource,
          lock: finding.lock,
          // Built here, where the region→file translation exists. See `describe.ts`
          // on why no detector is allowed to produce prose itself.
          evidence: describeFsmFinding(finding, toFileLine),
        })
      }
    }

    for (const rule of options.rules) {
      if ((ruleSites.get(rule.id) ?? 0) >= maxSites) {
        ruleCapped.set(rule.id, true)
        continue
      }
      const violations = ruleViolations({ lines: region, rules: [rule], bindings, events })

      for (const violation of violations) {
        if ((ruleSites.get(rule.id) ?? 0) >= maxSites) {
          ruleCapped.set(rule.id, true)
          break
        }
        ruleSites.set(rule.id, (ruleSites.get(rule.id) ?? 0) + 1)
        sites.push({
          kind: 'atomicity',
          fsm: null,
          ruleId: rule.id,
          filePath: fn.file_path,
          functionName: fn.name,
          startLine: fn.start_line,
          endLine: fn.end_line,
          matchLine: toFileLine(violation.line),
          checkLine: null,
          resource: violation.resource,
          lock: rule.lock,
          evidence: describeViolation(violation, rule, toFileLine),
        })
      }
    }

    // §4.4.3, CWE-364. Runs only on a function a registration identified as a
    // handler — which is not an optimisation but the shape's premise: an
    // `if (g_flag)` in ordinary code is not a signal race.
    if (prePass !== null) {
      const handler = prePass.handlers.get(handlerKey(fn.file_path, fn.name))
      if (handler !== undefined) {
        // Self-exclusion happens here rather than in the pre-pass, because which
        // function is "self" depends on which handler is being analysed.
        const others = new Map<string, SignalOtherLocation[]>()
        for (const [key, list] of prePass.touches) {
          const withoutSelf = list.filter(
            (entry) => entry.filePath !== fn.file_path || entry.functionName !== fn.name,
          )
          if (withoutSelf.length > 0) others.set(key, withoutSelf)
        }

        const result = runSignalShapes({
          lines: region,
          events,
          bindings,
          handler,
          scope: prePass.scopeOf(fn.file_path),
          otherTouches: others,
        })

        for (const finding of result.findings) {
          const { shape } = finding
          if ((signalSiteCount.get(shape) ?? 0) >= maxSites) {
            signalCapped.set(shape, true)
            continue
          }
          signalSiteCount.set(shape, (signalSiteCount.get(shape) ?? 0) + 1)

          const checkLine = signalFindingCheckLine(finding)
          sites.push({
            kind: 'signal',
            fsm: null,
            ruleId: null,
            shape,
            signals: [...finding.signals],
            filePath: fn.file_path,
            functionName: fn.name,
            startLine: fn.start_line,
            endLine: fn.end_line,
            // The far end of the claim, which is the line a reviewer reads first: the
            // invalidation for a window, the access for shared state, the call for the
            // two call shapes.
            matchLine: toFileLine(signalFindingLine(finding)),
            checkLine: checkLine === null ? null : toFileLine(checkLine),
            resource: finding.resource,
            lock: null,
            evidence: describeSignalFinding(finding, toFileLine),
          })
        }
      }
    }
  }

  const outcomes: ToctouSweepOutcome[] = [
    ...fsms.map((fsm) => ({
      producer: `fsm:${fsm}`,
      sites: fsmSites.get(fsm) ?? 0,
      capped: fsmCapped.get(fsm) ?? false,
    })),
    ...options.rules.map((rule) => ({
      producer: `rule:${rule.id}`,
      sites: ruleSites.get(rule.id) ?? 0,
      capped: ruleCapped.get(rule.id) ?? false,
    })),
    ...signalShapes.map((shape) => ({
      producer: signalProducer(shape),
      sites: signalSiteCount.get(shape) ?? 0,
      capped: signalCapped.get(shape) ?? false,
    })),
  ]

  for (const outcome of outcomes) {
    if (outcome.capped) {
      warnings.push(
        `Producer ${outcome.producer} reached the ${maxSites}-site cap; its sweep is partial.`,
      )
    }
  }

  log(
    `[toctou] swept ${coverage.functionsSwept} function(s), ` +
      `${sites.length} site(s) across ${outcomes.length} producer(s)`,
  )

  return { sites, outcomes, coverage, warnings }
}
