/**
 * Identifying signal handlers, and the async-signal-safety table (spec §4.4.3,
 * CWE-364).
 *
 * This module exists because of a fact about the weakness rather than a choice about
 * the code: **a signal handler is a handler because of who registered it**, and that
 * is a fact about a *different* function. The four machines in `fsm.ts` are handed a
 * function body and nothing else, and that is what keeps them honest; this one cannot
 * be, so the missing input is computed here, once, for the whole program.
 *
 * ## What counts as a registration
 *
 * Two calls install a handler, and both are matched on the *second argument* rather
 * than on the callee alone:
 *
 * - `signal(SIGINT, on_int)` — the BSD/POSIX form.
 * - `sigaction(SIGINT, &sa, NULL)` together with `sa.sa_handler = on_int` (or
 *   `->sa_handler`, or a designated initializer). The signal comes from the
 *   `sigaction` call whose second argument is the same object the field was assigned
 *   through, which is why the two are paired rather than read independently.
 *
 * `SIG_IGN` and `SIG_DFL` are *not* handlers, and treating them as such would be a
 * precision hole in the one relation everything else rests on: ignoring a signal
 * means the code in question runs nowhere.
 *
 * ## Name resolution is deliberately conservative
 *
 * A registration names a function, and the name is then resolved against the indexed
 * functions. Two translation units may both define `static void cleanup(int)` — legal
 * C — so matching on the bare name would attach one file's handler identity to the
 * other file's function. The resolution therefore prefers a same-file definition, and
 * when a name is declared in several files with no same-file match it is **dropped**
 * rather than guessed at, and reported as `ambiguous` so the drop is visible. That is
 * the same direction as every other ambiguity in this module: report less.
 */

import { normalizeExpression, stripAddress } from './alias'
import { callSites } from './events'
import { buildDefinitionIndex, resolveName } from './resolver'

import type { SignalHandler } from './types'

/**
 * Functions documented as **not** async-signal-safe, curated to the ones whose
 * unsafety comes from state the signal can interrupt.
 *
 * The build rule, since a table like this is only as good as its justification:
 *
 * - POSIX defines the async-signal-safe set as a *closed list*, and states that
 *   "all functions not listed in this table are considered to be unsafe with respect
 *   to signals". So membership here is not a judgement — but the *complement* of that
 *   list is everything, and sweeping for it would flag `sin()`.
 * - What is here instead is the families where the unsafety is *shared internal
 *   state*, which is what makes the interruption corrupt something: the stdio family
 *   (a static buffer plus its counters), the allocator family (global free lists),
 *   the logging family (buffers and locks), the static-buffer string/time family, and
 *   the process-termination family.
 *
 * Three exclusions are deliberate and each is a real distinction rather than an
 * omission:
 *
 * 1. **`abort`, `_exit`, `_Exit`, `quick_exit`** are async-signal-safe and are the
 *    *documented replacement* for `exit`. `exit` and `atexit` are here; those are not.
 * 2. **`close` is safe and `fclose` is not.** `close` is in the POSIX list; `fclose`
 *    is stdio. A handler that closes a descriptor is fine, and a table that flagged
 *    it would be noise.
 * 3. **The `_r` reentrant variants are not here at all** — not `strtok_r` (which is
 *    genuinely safe) and not `localtime_r`, `strerror_r` or `asctime_r` (which are
 *    not, because they still touch `tzset` and static state). They are the
 *    *conventional* fix a reader will reach for, and a finding that names
 *    `localtime_r` is one a reviewer dismisses on sight. The recall is spent on
 *    purpose, which is the same trade `events.ts` makes for fetches and releases.
 *
 * This is a **non-transitive** table: a handler that calls a project function which
 * in turn calls `printf` is not caught, because that needs a call graph this module
 * does not build. Recorded in §20.23.
 */
export const ASYNC_UNSAFE_CALLS = [
  // stdio: a static buffer and the counters that index it.
  'printf',
  'fprintf',
  'sprintf',
  'snprintf',
  'vprintf',
  'vfprintf',
  'vsprintf',
  'vsnprintf',
  'dprintf',
  'vdprintf',
  'puts',
  'fputs',
  'fputc',
  'putchar',
  'putc',
  'fwrite',
  'fread',
  'fgets',
  'fgetc',
  'getchar',
  'getc',
  'scanf',
  'fscanf',
  'sscanf',
  'perror',
  'fflush',
  'fopen',
  'fclose',
  'freopen',
  'fdopen',
  'setbuf',
  'setvbuf',
  'tmpfile',
  'tmpnam',
  'tempnam',
  'fileno',
  // the allocator: global free lists.
  'malloc',
  'calloc',
  'realloc',
  'free',
  'strdup',
  'strndup',
  'asprintf',
  'vasprintf',
  'posix_memalign',
  // logging: buffers, and a lock taken inside `syslog`.
  'syslog',
  'vsyslog',
  'openlog',
  'closelog',
  'setlogmask',
  // static buffers: the non-reentrant halves of the `*_r` pairs.
  'strtok',
  'strerror',
  'strsignal',
  'asctime',
  'ctime',
  'localtime',
  'gmtime',
  'basename',
  'dirname',
  'getenv',
  'setenv',
  'putenv',
  'inet_ntoa',
  'getpwnam',
  'getpwuid',
  'getgrnam',
  'getgrgid',
  'gethostbyname',
  'getaddrinfo',
  // pseudo-random state.
  'rand',
  'random',
  'srand',
  'srandom',
  // termination: `exit` runs `atexit` handlers and flushes stdio.
  'exit',
  'atexit',
  'system',
  'popen',
  'pclose',
  // locks: taking a lock a handler can already hold is the deadlock writing itself.
  'pthread_mutex_lock',
  'pthread_mutex_unlock',
  'pthread_mutex_trylock',
  'pthread_cond_wait',
  'pthread_cond_signal',
  'pthread_create',
  'pthread_join',
  'sem_wait',
] as const

const UNSAFE = new Set<string>(ASYNC_UNSAFE_CALLS)

/** Whether a callee is one of the curated not-async-signal-safe functions. */
export const isAsyncUnsafe = (callee: string): boolean => UNSAFE.has(callee)

/**
 * Calls that do not return to the interrupted code.
 *
 * Kept separate from `ASYNC_UNSAFE_CALLS` because they are **not** a
 * signal-safety violation and labelling them as one would be wrong: `longjmp` and
 * `siglongjmp` *are* in POSIX's async-signal-safe list. They are here because
 * CWE-364 enumerates them separately — "use of `setjmp` and `longjmp`, or other
 * mechanisms that prevent a signal handler from returning control back to the
 * original functionality" — and because the failure is different in kind: the
 * interrupted function does not resume, so any state it was midway through
 * updating is simply never unwound. See CVE-2000-0573 / VU#834865.
 */
export const NON_LOCAL_JUMP_CALLS = ['longjmp', 'siglongjmp', '_longjmp'] as const

const JUMPS = new Set<string>(NON_LOCAL_JUMP_CALLS)

export const isNonLocalJump = (callee: string): boolean => JUMPS.has(callee)

/**
 * Arguments that stand for *no handler* rather than for one.
 *
 * `signal(SIGINT, SIG_IGN)` is not a registration, and a version of this module that
 * missed that would report every deliberately ignored signal as a handler with an
 * empty body — a false premise for all four shapes.
 */
const NON_HANDLERS = new Set([
  'SIG_IGN',
  'SIG_DFL',
  'SIG_HOLD',
  'SIG_ERR',
  'NULL',
  'nullptr',
  '0',
])

/** A registration as it was written, before the function it names is resolved. */
export interface Registration {
  /** The function name read out of the call. */
  handler: string
  /** The signal constant, or the empty string when it could not be paired. */
  signal: string
  via: 'signal' | 'sigaction'
  /** The registering function's own file and line — where the call was written. */
  filePath: string
  line: number
  registeredIn: string
  /** Set when the region mentions `SA_NODEFER`; see `registrationsIn`. */
  nodefer: boolean
}

export interface HandlerCandidate {
  name: string
  filePath: string
  /** The function's own region lines. */
  lines: readonly string[]
}

export interface SignalHandlerIndex {
  /** Keyed by `handlerKey(filePath, name)` — see the module note on why not by name. */
  handlers: ReadonlyMap<string, SignalHandler>
  /** Registrations naming a function the program model does not have. */
  unresolved: string[]
  /** Registrations naming a name more than one file defines, with no same-file match. */
  ambiguous: string[]
}

/** Strip spaces and tabs, so a structural match does not have to spell whitespace. */
const compact = (line: string): string => line.split(' ').join('').split('\t').join('')

/** A function name, or null when the argument is not a plain identifier. */
const handlerName = (argument: string): string | null => {
  const value = stripAddress(normalizeExpression(argument))
  if (value.length === 0) return null
  if (NON_HANDLERS.has(value)) return null
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : null
}

/**
 * The `sa_handler`/`sa_sigaction` assignments in a region, and which object each
 * wrote through.
 *
 * The base matters because it is how the assignment is paired with the `sigaction`
 * call: `sa.sa_handler = f` and `sigaction(SIGINT, &sa, NULL)` are only the same
 * registration if both mention `sa`.
 */
/** The struct a `sa_handler` write went through, or the empty string when unnamed. */
const SA_FIELD = /([A-Za-z_][A-Za-z0-9_]*)(?:->|\.)sa_(?:handler|sigaction)=([A-Za-z_][A-Za-z0-9_]*)/
/**
 * The designated-initialiser form, which has no base to name.
 *
 * `struct sigaction sa = { .sa_handler = on_usr };` — the character before the dot is
 * a brace or a comma, so there is no expression to pair with a `sigaction` call. The
 * signal is recovered (or not) by the unique-call fallback below.
 */
const SA_INITIALISER = /[{,][.]sa_(?:handler|sigaction)=([A-Za-z_][A-Za-z0-9_]*)/

interface FieldAssignment {
  base: string
  handler: string
  line: number
  /**
   * Set when a `sigaction` call's struct argument matched this assignment.
   *
   * A flag on the assignment rather than a lookup by handler name, and that is a real
   * correction: one handler assigned to two structs is two registrations, and a
   * name-based check would mark the second "already paired" and silently drop it.
   */
  paired: boolean
}

const handlerAssignments = (lines: readonly string[]): FieldAssignment[] => {
  const found: FieldAssignment[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const text = compact(lines[index]!)

    // The based form first, and deliberately: on `sa.sa_handler=f` an
    // initialiser-shaped pattern would match with no base and lose the pairing.
    const based = SA_FIELD.exec(text)
    if (based) {
      const name = handlerName(based[2]!)
      if (name !== null) {
        found.push({ base: based[1]!, handler: name, line: index + 1, paired: false })
      }
      continue
    }

    const designated = SA_INITIALISER.exec(text)
    if (!designated) continue
    const name = handlerName(designated[1]!)
    if (name !== null) found.push({ base: '', handler: name, line: index + 1, paired: false })
  }

  return found
}

/**
 * Every registration written in one function region.
 *
 * Exported because it is the part of this module a reader should be able to test and
 * disagree with directly: whether a given call installs a handler is the module's
 * actual judgement about C, and it should not have to be read out of control flow.
 */
export const registrationsIn = (candidate: HandlerCandidate): Registration[] => {
  const registrations: Registration[] = []
  // `SA_NODEFER` is read per *function*, not per registration, because it appears in
  // the `sigaction` flags argument or in the struct being filled, and pairing it
  // precisely would mean modelling the struct. Over-reporting it here means shape B
  // fires; that is the one place in this module where the coarse reading is the
  // *recall*-facing one, and it is recorded in §20.23.
  const nodefer = candidate.lines.some((line) => line.includes('SA_NODEFER'))
  const assignments = handlerAssignments(candidate.lines)

  for (let index = 0; index < candidate.lines.length; index += 1) {
    const raw = candidate.lines[index]!
    const line = index + 1

    for (const site of callSites(raw)) {
      if (site.callee === 'signal') {
        const signal = normalizeExpression(site.args[0] ?? '')
        const handler = handlerName(site.args[1] ?? '')
        if (handler === null) continue
        registrations.push({
          handler,
          signal,
          via: 'signal',
          filePath: candidate.filePath,
          line,
          registeredIn: candidate.name,
          nodefer,
        })
        continue
      }

      if (site.callee !== 'sigaction') continue

      // The handler is not an argument to `sigaction`; it is whatever was assigned to
      // the struct this call was given. Pair by the struct's name.
      const target = stripAddress(normalizeExpression(site.args[1] ?? ''))
      if (target.length === 0) continue
      const signal = normalizeExpression(site.args[0] ?? '')

      for (const assignment of assignments) {
        if (assignment.base !== target) continue
        assignment.paired = true
        registrations.push({
          handler: assignment.handler,
          signal,
          via: 'sigaction',
          filePath: candidate.filePath,
          line: assignment.line,
          registeredIn: candidate.name,
          nodefer,
        })
      }
    }
  }

  // The signals named by this region's own `sigaction` calls, deduplicated and in
  // order. Used once below, and only when it is unambiguous.
  const callSignals = [
    ...new Set(
      candidate.lines.flatMap((line) =>
        callSites(line)
          .filter((site) => site.callee === 'sigaction')
          .map((site) => normalizeExpression(site.args[0] ?? ''))
          .filter((signal) => signal.length > 0),
      ),
    ),
  ]

  // A `sa_handler = f` that no `sigaction` call in this function named still installs
  // a handler — the call may sit in another function. It is registered with no signal,
  // which costs the `reentrancy-window` shape (an unknown signal set cannot establish
  // re-entrancy) and is the precision-holding direction. The exception is the one case
  // where the signal is still knowable: a region with exactly one distinct `sigaction`
  // signal, where the assignment can only be that registration. With two, guessing
  // which is a coin flip, and a wrong signal would make the re-entrancy claim false.
  for (const assignment of assignments) {
    if (assignment.paired) continue
    const inferred = callSignals.length === 1 ? callSignals[0]! : ''
    registrations.push({
      handler: assignment.handler,
      signal: inferred,
      via: 'sigaction',
      filePath: candidate.filePath,
      line: assignment.line,
      registeredIn: candidate.name,
      nodefer,
    })
  }

  return registrations
}

/**
 * Resolve every registration against the indexed functions.
 *
 * The policy itself — same-file wins, a single definition resolves, a genuine
 * ambiguity is dropped — lives in `resolver.ts`, so a signal registration and a
 * callee name resolve the same way rather than by two copies of the same rule. This
 * function supplies only the vocabulary: which name, which file it was registered
 * in, and the message a dropped resolution produces.
 */
export const findSignalHandlers = (
  candidates: readonly HandlerCandidate[],
): SignalHandlerIndex => {
  const index = buildDefinitionIndex(
    candidates.map((candidate) => ({ name: candidate.name, filePath: candidate.filePath })),
  )

  const handlers = new Map<string, SignalHandler>()
  const unresolved: string[] = []
  const ambiguous: string[] = []

  for (const candidate of candidates) {
    for (const registration of registrationsIn(candidate)) {
      const resolution = resolveName(index, registration.handler, registration.filePath)
      if (resolution.kind === 'unresolved') {
        unresolved.push(`${registration.handler} (registered in ${registration.filePath})`)
        continue
      }
      if (resolution.kind === 'ambiguous') {
        ambiguous.push(
          `${registration.handler} (registered in ${registration.filePath}, defined in ` +
            `${resolution.fileCount} files)`,
        )
        continue
      }

      const file = resolution.filePath
      const key = `${file}\u0000${registration.handler}`
      const existing = handlers.get(key)

      if (existing === undefined) {
        handlers.set(key, {
          name: registration.handler,
          signals: registration.signal.length > 0 ? [registration.signal] : [],
          via: registration.via,
          nodefer: registration.nodefer,
          filePath: file,
          line: registration.line,
        })
        continue
      }

      // The accumulation is the machine's precondition, not bookkeeping: a second
      // signal on one handler is what makes re-entry possible.
      if (registration.signal.length > 0 && !existing.signals.includes(registration.signal)) {
        existing.signals.push(registration.signal)
      }
      if (registration.nodefer) existing.nodefer = true
    }
  }

  return { handlers, unresolved, ambiguous }
}
