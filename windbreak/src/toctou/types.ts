/**
 * The TOCTOU / race module (spec §4.4.3).
 *
 * §4.4.3 calls this the flagship capability and gives it four parts:
 *
 * 1. **Mine atomicity rules** from historical patches — which shared variables or
 *    locks must not be touched between a check and its corresponding use.
 * 2. **Encode four dangerous check-to-use patterns as finite state machines.**
 * 3. **Validate candidate code paths against the FSMs**, with alias analysis on
 *    locks and on the checked/used variables to hold precision.
 * 4. Priority: **logic flaw over memory corruption**, per HARDLINE's decision.
 *
 * The first three are what this module implements; the fourth is why the
 * detection is shaped the way it is rather than being another memory-safety pass.
 *
 * ## The four FSMs are an interpretation, and it is worth being explicit about it
 *
 * §4.4.3 says "the four **known** dangerous check-to-use patterns" — a definite
 * article and a count, with no list. The list is therefore not in the spec, and
 * this module had to supply one. What it supplies is the four that the TOCTOU
 * literature and the CWE-367 family agree on, each distinguishable from the others
 * by *what changes between the check and the use*:
 *
 * | FSM | What changes in between |
 * |---|---|
 * | `path-check-then-use` | the name-to-object binding (the path is re-resolved) |
 * | `double-fetch` | the value itself (the source is read a second time) |
 * | `lock-scope` | nothing — the invariant was never held at use time |
 * | `lifetime-race` | the object's lifetime (it is released and still used) |
 *
 * They are also the four §4.4.3's comparison point implies are not covered well by
 * a shallow same-path check-then-use match: `path-check-then-use` *is* that
 * SonarQube rule, and the other three are the classes one step past it. So the
 * design has a deliberate shape: one FSM at parity with the nearest commercial
 * tool, three that are not, all sharing one event vocabulary.
 *
 * If the intended four were different, this is the file to change and the change
 * is contained: each FSM is one function in `fsm.ts` over the same event stream.
 * It is recorded as an open item in §20.22 rather than presented as settled.
 *
 * ## The fifth machine is not an interpretation, and it is shaped differently
 *
 * CWE-364 (signal handler race) is the one race class §4.4.3's four machines cannot
 * express, and unlike the four it does **not** need a list invented for it: MITRE's
 * entry enumerates its own behaviours, and the four in `SIGNAL_SHAPES` are those,
 * with CWE-828/479 (non-async-signal-safe functionality in a handler) as a declared
 * child of 364 rather than as a neighbour. So this machine carries no "which four
 * did they mean" caveat — the caveats it does carry are about the *analysis*, and
 * they are recorded in `handlers.ts` and `signal.ts` where the judgements live.
 *
 * It is separate from `fsm.ts` for two structural reasons, both of which are facts
 * about CWE-364 rather than conveniences:
 *
 * 1. **A handler is a handler because of who registered it**, which is a fact about
 *    *another* function. The four machines are handed a function body and nothing
 *    else; this one cannot be. `handlers.ts` is that missing input.
 * 2. **Its defects are not check-to-use pairs.** "This handler calls `syslog`" and
 *    "this global is shared with the regular code" have no check end and no middle
 *    event, so forcing them into `ToctouFinding` would mean three fields that are
 *    fictional. `SignalFinding` carries exactly the lines each shape has.
 *
 * ## Why events, and why the FSMs are separate from detection
 *
 * Everything is expressed as a stream of `AtomicEvent`s over a function body,
 * because all four patterns are statements about *ordering* — a check, then
 * something, then a use — and ordering is exactly what a line-oriented regex
 * cannot express. Once the events exist, each FSM is a small state machine over
 * them and the alias relation is the only thing that decides whether two events
 * are about the same resource.
 */

/**
 * The four synchronous FSMs. See the module note for why this list and not another.
 *
 * A closed union, so extending it is a compile error at every switch that has to
 * care rather than a pattern that silently never runs. `SIGNAL_SHAPES` is a
 * *separate* union rather than a fifth member here, because the signal machine is
 * driven by an input and emits a finding type that these four do not share.
 */
export const TOCTOU_FSMS = [
  'path-check-then-use',
  'double-fetch',
  'lock-scope',
  'lifetime-race',
] as const

export type ToctouFsm = (typeof TOCTOU_FSMS)[number]

/** Human-readable one-liners, used in the report and in candidate messages. */
export const FSM_DESCRIPTIONS: Record<ToctouFsm, string> = {
  'path-check-then-use':
    'a path is checked and then re-resolved by a later call, so the check can hold for a different object than the use',
  'double-fetch':
    'a value is read, checked, and then read again from the same source; the second read is what the check did not see',
  'lock-scope':
    'a resource is checked under a lock that is released before the resource is used',
  'lifetime-race':
    'a resource passes a validity check, is released, and is then used',
}

/**
 * The signal-handler shapes (CWE-364), driven by `signal.ts`.
 *
 * MITRE's CWE-364 entry enumerates the behaviours that "have received the label of
 * signal handler race condition"; these are those, minus the two that are not
 * separately detectable (a handler associated with multiple signals is the
 * *precondition* for `reentrancy-window` rather than a defect on its own — the same
 * handler on two signals is not a bug until it also has a window to re-enter — and
 * "shared state between one handler and another" is `shared-state` with the other
 * location happening to be a handler).
 *
 * `unsafe-call` is CWE-828 → 479 rather than 364 directly: MITRE makes
 * "Signal Handler with Functionality that is not Asynchronous-Safe" a child of 364
 * and "Use of a Non-reentrant Function" a child of that. Calling it a race would be
 * the one overclaim this module must not make, which is why the shape exists and is
 * labelled with its own id.
 */
export const SIGNAL_SHAPES = [
  'unsafe-call',
  'reentrancy-window',
  'shared-state',
  'non-local-jump',
] as const

export type SignalShape = (typeof SIGNAL_SHAPES)[number]

/**
 * The producer id a signal shape reports under.
 *
 * One function so the sweep's per-shape counts and the candidate rows name the same
 * thing, which is the same property `producerId` establishes for the FSM producer.
 */
export const signalProducer = (shape: SignalShape): string => `signal:${shape}`

export const SIGNAL_SHAPE_DESCRIPTIONS: Record<SignalShape, string> = {
  'unsafe-call':
    'the handler calls a function that is not async-signal-safe, so the signal can interrupt that function mid-update and the handler corrupts its state',
  'reentrancy-window':
    'the handler releases a resource and only clears the reference afterwards, so a second delivery re-enters inside that window and releases it twice',
  'shared-state':
    'the handler and other code both touch a non-atomic object, so whichever is interrupted sees the other half-finished',
  'non-local-jump':
    'the handler does not return to the interrupted code, so the state it interrupted is never unwound',
}

/**
 * A location in *another* function, for the one shape whose claim spans two.
 *
 * The field is `fileLine` and not `line` deliberately. Every other line on a
 * `SignalFinding` is relative to the region being analysed and is translated by the
 * sweep; this one was translated by the pre-pass that found it, because there is no
 * single region to translate it against. Two different meanings for the same word is
 * exactly the bug `describe.ts` was built to make impossible, so the two carry
 * different names and a reader has to notice which one they are holding.
 */
export interface SignalOtherLocation {
  filePath: string
  functionName: string
  /** File-relative, unlike every other line on a `SignalFinding`. */
  fileLine: number
  /** True when that function writes the shared object. */
  written: boolean
  /** True when that function is itself a signal handler (MITRE's other sub-case). */
  isHandler: boolean
}

/**
 * One signal-handler defect.
 *
 * A union rather than one record with nullable fields, because the four shapes carry
 * genuinely different ends: `unsafe-call` is one line, `reentrancy-window` is two in
 * the same body, `shared-state` is one here and one in another function, and
 * `non-local-jump` is one. The alternative would be a record where every shape reads
 * three fields it knows are meaningless.
 */
export type SignalFinding =
  | {
      shape: 'unsafe-call'
      /** 1-based line of the call, relative to the region. */
      line: number
      /** The callee — the unsafe function itself. */
      resource: string
      callee: string
      signals: string[]
    }
  | {
      shape: 'reentrancy-window'
      /** 1-based line of the release, relative to the region. */
      releaseLine: number
      /** 1-based line of the invalidation that was meant to close the window. */
      invalidateLine: number
      resource: string
      signals: string[]
    }
  | {
      shape: 'shared-state'
      /** 1-based line of the handler's own touch, relative to the region. */
      line: number
      /** True when the handler writes the shared object. */
      wrote: boolean
      resource: string
      /** The other function that touches it — already file-absolute. */
      other: SignalOtherLocation
      signals: string[]
    }
  | {
      shape: 'non-local-jump'
      /** 1-based line of the jump, relative to the region. */
      line: number
      /** The callee — `longjmp` or `siglongjmp`. */
      resource: string
      callee: string
      signals: string[]
    }

/**
 * How a signal-handler sweep names the function it is about.
 *
 * Keyed on file *and* name, not on name. Two translation units can both define a
 * `static void cleanup(int)`; matching on the bare name would attach one file's
 * handler identity to the other file's function, which is a precision hole in the
 * relation the whole machine rests on.
 */
export const handlerKey = (filePath: string, name: string): string =>
  `${filePath}\u0000${name}`

/**
 * What one step of a function body can be, from the race module's point of view.
 *
 * `call` exists as well as `use` because an unclassified call is a *potential* use
 * of its arguments: treating it as `use` would fire the lifetime FSM on any call
 * that happens to mention a released pointer, while ignoring it entirely would
 * miss `process(p)` after `free(p)`. Keeping it distinct lets the FSMs decide.
 */
export const ATOMIC_EVENT_KINDS = [
  'check',
  'fetch',
  'lock',
  'unlock',
  'use',
  'release',
  'call',
] as const

export type AtomicEventKind = (typeof ATOMIC_EVENT_KINDS)[number]

export interface AtomicEvent {
  kind: AtomicEventKind
  /** 1-based line within the function region. */
  line: number
  /**
   * The normalised expression the event is about — the checked resource, the lock,
   * the used value. Empty when the event has no operand.
   */
  key: string
  /** The source text, for the evidence line. */
  text: string
  /** The callee, when the event is a call. */
  callee: string | null
  /**
   * `fetch` only: the local the value landed in.
   */
  target: string | null
  /**
   * `fetch` only: the external source the value was read from — the thing that can
   * change between two reads.
   */
  source: string | null
}

/**
 * One detected check-to-use defect.
 *
 * Deliberately carries no prose. The lines here are **region-relative**, because
 * that is all an FSM can know — it is handed a function body, not a file — and the
 * sentence a reviewer reads has to name lines they can open. Keeping the prose out
 * of this type makes that structural rather than a convention: there is no number
 * here to accidentally print, and `describe.ts` is the only thing that turns a
 * finding into words, taking the line translation as an argument.
 */
export interface ToctouFinding {
  fsm: ToctouFsm
  /** 1-based line of the check, relative to the function region. */
  checkLine: number
  /**
   * The FSM's middle event, when it has one: the first read for `double-fetch`, the
   * release for `lifetime-race`, the unlock for `lock-scope`. Null for
   * `path-check-then-use`, which has nothing between its two ends, and for a
   * `lock-scope` region whose release the function does not show.
   */
  middleLine: number | null
  /** 1-based line of the use, relative to the function region. */
  useLine: number
  /** Normalised resource both events are about. */
  resource: string
  /** The lock involved, when the FSM is about lock scope. */
  lock: string | null
}

/**
 * One site that touched a mined rule's resource without its lock.
 *
 * The second producer's finding type, and not a `ToctouFinding`: an atomicity
 * violation is a statement about one line with no check end and no middle event, so
 * forcing it into the FSM shape would mean three fields that are always null. It
 * also has no `evidence`, for the same reason `ToctouFinding` has none — the prose is
 * built once, in `describe.ts`, where the line translation is available.
 */
export interface RuleViolation {
  /** 1-based line of the unprotected access, relative to the function region. */
  line: number
  resource: string
  lock: string
  /**
   * True when the function holds this lock *somewhere* but not at that line, as
   * opposed to never holding it. The two read differently to a reviewer: a
   * mis-scoped lock is a different fix from a missing one.
   */
  heldElsewhere: boolean
}

/**
 * What the callers of a function do with an atomicity rule's lock.
 *
 * The counterexample this exists to answer is a helper that is only ever reached
 * with the lock held: reported from inside the helper it looks like a violation, and
 * read from its callers it is the fix. `lockedCallers === callers` is the evidence
 * for that reading, and `complete` is what says whether the count can be trusted — a
 * name several files define, or a call site no indexed function covers, means there
 * may be a caller the graph cannot see.
 *
 * It carries no suppression. A call graph built from call expressions cannot see a
 * function whose address is taken, so this is a strong hint for a reviewer rather
 * than a proof, and the module annotates instead of deleting. See `lockcontext.ts`.
 */
export interface CallerLockContext {
  /** Call sites into this function that the call graph attributed and resolved. */
  callers: number
  /** How many of those hold the rule's lock across the call. */
  lockedCallers: number
  /**
   * Whether every call to this function was attributed and resolved.
   *
   * False means the caller count is a lower bound. Kept as its own field rather than
   * folded into `allCallersLocked`, because both halves matter to the sentence: "all
   * three recorded callers hold it" and "there may be a fourth" are both true, and a
   * reviewer needs both.
   */
  complete: boolean
  /** True when the caller set is complete and every one of them holds the lock. */
  allCallersLocked: boolean
}

/**
 * Where a checked name is re-resolved, in the function the caller reached.
 *
 * The field is `fileLine` and not `line` for the same reason
 * `SignalOtherLocation.fileLine` is: every other line on a site is relative to the
 * region being analysed and is translated by the sweep, whereas this one is already
 * file-absolute. Two meanings for one word is what `describe.ts` exists to make
 * impossible.
 */
export interface InterprocOtherLocation {
  filePath: string
  functionName: string
  /** File-relative, unlike the site's own translated lines. */
  fileLine: number
  /** The path-resolving call that re-binds the name, e.g. `open`. */
  callee: string
}

/**
 * A signal handler, as identified from the call that installed it.
 *
 * `signals` accumulates across registrations, and that accumulation is the
 * machine's precondition rather than a detail: a handler installed for two signals
 * (or one, with `SA_NODEFER`) can be re-entered, which is what makes the
 * `reentrancy-window` shape possible in code whose release-then-clear pair is
 * correct in a single-threaded reading.
 */
export interface SignalHandler {
  name: string
  /** Signal constants it was registered for, deduplicated, in registration order. */
  signals: string[]
  /** Which call installed it — they read differently in evidence. */
  via: 'signal' | 'sigaction'
  /** True when a registration for it carries `SA_NODEFER`. */
  nodefer: boolean
  filePath: string
  /** File-relative line of the first registration. */
  line: number
}

/**
 * What a file declares outside every function, which is what makes a key *shared*.
 *
 * A race between a handler and the regular code needs an object both can name, and
 * in C that means file scope. Collecting that set is also how the documented fix is
 * recognised: `sig_atomic_t` is the one type a handler may assign to, so a key
 * declared with it is the compliant solution rather than a finding.
 */
export interface FileScopeDeclarations {
  globals: ReadonlySet<string>
  /** The subset declared `sig_atomic_t`, i.e. the documented-correct mechanism. */
  sigAtomic: ReadonlySet<string>
}

/**
 * A mined atomicity rule: this resource is only touched with this lock held.
 *
 * §4.4.3 asks for these to be mined from historical patches, which is what
 * `rules.ts` does — the same insight as §4.4.1's shape mining, applied to *locks*
 * instead of to guards. A rule is therefore evidence that the project itself
 * considers the pairing necessary, which is a much stronger premise than a generic
 * "shared data needs a lock" heuristic.
 */
export interface AtomicityRule {
  /** Stable key: the resource and the lock, since that is what the sweep uses. */
  id: string
  resource: string
  lock: string
  originPatchSha: string
  originFile: string
  /** How many hunks across the history established this pairing. */
  occurrences: number
}

/**
 * The fields every site carries, whichever producer found it.
 *
 * One record for both producers rather than two, because everything downstream —
 * the candidate normaliser, the candidate row, triage's prompt — wants the same
 * shape: a file, a function, a line, and a sentence.
 */
interface ToctouSiteBase {
  filePath: string
  /** The enclosing function, from the program model. */
  functionName: string
  /** 1-based, matching `symbols.start_line`. */
  startLine: number
  endLine: number
  /** The line to point a reviewer at — the use, for both producers. */
  matchLine: number
  /** Normalized resource the finding is about. */
  resource: string
  /** The lock involved, when the finding is about one. */
  lock: string | null
  evidence: string
}

/**
 * A site the module reports.
 *
 * Discriminated on `kind`, so the producers cannot be confused where it matters: an
 * FSM finding always knows which FSM fired and always has the *other* end of its
 * check-to-use path; an atomicity violation always knows which mined rule it broke
 * and has no path — it is a statement about one line, not two; and a signal finding
 * knows which CWE-364 shape it is and which signals installed the handler. The
 * alternative, one interface with nullable fields, would force every reader to
 * handle a combination that cannot occur.
 *
 * `signal` is a third kind rather than a fifth FSM because a signal finding has no
 * check-to-use path at all — see the module note. It is *not* a signal finding
 * wearing an FSM's fields.
 */
export type ToctouSite =
  | (ToctouSiteBase & {
      kind: 'fsm'
      /* Which FSM fired. */
      fsm: ToctouFsm
      ruleId: null
      /** The check end of the path. */
      checkLine: number
    })
  | (ToctouSiteBase & {
      kind: 'atomicity'
      fsm: null
      /* Which mined rule was violated. */
      ruleId: string
      /** Always null: a rule violation is one line, not a path. */
      checkLine: null
      /**
       * What this function's callers do with the rule's lock. Null when the
       * interprocedural pass did not run.
       *
       * Only the atomicity kind carries it: a rule is a statement about a lock, and a
       * lock is the one thing a caller can hold across a call that changes the
       * finding. An FSM site's two ends are both in the body it was found in.
       */
      callerLock: CallerLockContext | null
    })
  | (ToctouSiteBase & {
      kind: 'interproc'
      fsm: null
      ruleId: null
      /**
       * The caller's path check.
       *
       * The same field the FSM kind uses for the earlier end of its pair, because it
       * plays the same role: the check the use was entitled to rely on. It is
       * file-relative like every line on a site — the sweep translated it.
       */
      checkLine: number
      /**
       * Where the name is re-resolved, in another function and possibly another file.
       *
       * `matchLine` is the *call* in this function that reaches it, because that is the
       * line a reviewer opens first; the far end is here, with its own file named.
       */
      other: InterprocOtherLocation
    })
  | (ToctouSiteBase & {
      kind: 'signal'
      fsm: null
      ruleId: null
      /* Which CWE-364 shape fired. */
      shape: SignalShape
      /*
       * The signals the handler was registered for. Carried rather than left to the
       * report because they are the *premise* of the claim — "a single-signal
       * handler installed without SA_NODEFER cannot be re-entered" is the reason the
       * `reentrancy-window` shape reports nothing, and a reviewer disagreeing with
       * that needs to see which signals were involved.
       */
      signals: string[]
      /**
       * The release line for a `reentrancy-window`, else null. Named `checkLine`
       * because it plays the same role the other kinds' field does — the earlier end
       * of the claim — but there is no check on any signal shape.
       */
      checkLine: number | null
    })

/** Per-producer sweep counts, so a truncated sweep cannot read as a complete one. */
export interface ToctouSweepOutcome {
  /** `fsm:<name>` or `rule:<id>`. */
  producer: string
  sites: number
  /** True when the producer's cap was reached. */
  capped: boolean
}

export interface ToctouCoverage {
  commitsRead: number
  /** Hunks that added locking, i.e. the rule miner's denominator. */
  hunksAddingLock: number
  /** Hunks that added locking but yielded no identifiable resource. */
  hunksWithoutResource: number
  /** Functions the sweep walked. */
  functionsSwept: number
  /** Functions with a non-empty event stream. */
  functionsWithEvents: number
  /**
   * Functions the handler pre-pass identified as signal handlers.
   *
   * The signal machine's denominator, and the number that makes "no signal findings"
   * readable: a target with no handlers is a clean result, whereas a target with
   * twelve and no findings is a claim about those twelve.
   */
  signalHandlers: number
  /**
   * File-scope objects the pre-pass found touched inside handlers that were not
   * declared `sig_atomic_t` — the `shared-state` shape's input set.
   */
  sharedKeys: number
  /**
   * Callables in the program model this stage did **not** sweep because their
   * language has no tables for any of the detectors the stage runs (see
   * `detectors/capability.ts`).
   *
   * The number that stops a near-empty candidate list on a Python repository
   * from reading as a clean one: the sweep's tables are C's, and saying so is
   * different from reporting that nothing was found.
   */
  noDetectorTables: number
  /**
   * Atomicity sites whose every recorded caller holds the rule's lock.
   *
   * The precision signal the interprocedural pass adds without deleting anything: a
   * high count means a large share of the target's atomicity candidates are helpers
   * reached only under the lock, which is a fact about the code's style and worth
   * knowing before reviewing them one at a time.
   */
  callerGuardedSites: number
  /**
   * Call edges the interprocedural pass resolved — the call graph's size.
   *
   * The denominator that makes an empty interprocedural result readable. "No
   * cross-function check-to-use pair" and "no call graph to look for one in" print the
   * same number of sites, and only this line tells them apart.
   */
  callEdges: number
  /** Call sites read from the program model — what `callEdges` is a fraction of. */
  callSitesSeen: number
  /**
   * Call sites no indexed callable covers, so they belong to no known caller.
   *
   * A call in a global initialiser, or in a file recon could not parse. It makes a
   * caller set a lower bound, which is why a site's `callerLock.complete` can be false.
   */
  callSitesUnattributed: number
  /**
   * Call sites whose callee name several files define with no same-file match.
   *
   * Dropped rather than guessed at, so these too make a caller set partial. Counted
   * apart from `callSitesUnattributed` because the two failures have different causes
   * and different fixes: one is a parsing gap, the other a name-resolution one.
   */
  callSitesAmbiguous: number
}
