import { describe, expect, test } from 'bun:test'

import { findSignalHandlers, isAsyncUnsafe, isNonLocalJump, registrationsIn } from './handlers'
import { handlerKey } from './types'

import type { HandlerCandidate } from './handlers'

const source = (...lines: string[]): string[] => lines

const candidate = (name: string, lines: string[], filePath = 'src/main.c'): HandlerCandidate => ({
  name,
  filePath,
  lines,
})

describe('registrationsIn', () => {
  test('reads a handler out of signal()', () => {
    const found = registrationsIn(
      candidate('main', source('int main(void) {', '  signal(SIGINT, on_int);', '  return 0;', '}')),
    )

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      handler: 'on_int',
      signal: 'SIGINT',
      via: 'signal',
      line: 2,
    })
  })

  test('SIG_IGN and SIG_DFL install no handler', () => {
    // A version that missed this would report every deliberately ignored signal as a
    // handler with an empty body — a false premise for all four shapes.
    const found = registrationsIn(
      candidate('main', source('int main(void) {', '  signal(SIGPIPE, SIG_IGN);', '}')),
    )

    expect(found).toEqual([])
  })

  test('reads a handler out of sigaction plus its struct assignment', () => {
    const found = registrationsIn(
      candidate(
        'main',
        source(
          'int main(void) {',
          '  struct sigaction sa;',
          '  sa.sa_handler = on_hup;',
          '  sigaction(SIGHUP, &sa, NULL);',
          '  return 0;',
          '}',
        ),
      ),
    )

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ handler: 'on_hup', signal: 'SIGHUP', via: 'sigaction' })
  })

  test('a pointer base is paired through the pointer', () => {
    const found = registrationsIn(
      candidate(
        'main',
        source(
          'int main(void) {',
          '  struct sigaction *sa = &global_sa;',
          '  sa->sa_handler = on_term;',
          '  sigaction(SIGTERM, sa, NULL);',
          '}',
        ),
      ),
    )

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ handler: 'on_term', signal: 'SIGTERM' })
  })

  test('reads a designated initialiser when the region names one signal', () => {
    const found = registrationsIn(
      candidate(
        'main',
        source(
          'int main(void) {',
          '  struct sigaction sa = { .sa_handler = on_usr };',
          '  sigaction(SIGUSR1, &sa, NULL);',
          '}',
        ),
      ),
    )

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ handler: 'on_usr', signal: 'SIGUSR1' })
  })

  test('two sigaction signals leave a designated initialiser unpaired rather than guessed', () => {
    // The signal set is what makes the re-entrancy claim; a coin flip here would make
    // it false rather than unknown.
    const found = registrationsIn(
      candidate(
        'main',
        source(
          'int main(void) {',
          '  struct sigaction a = { .sa_handler = on_usr };',
          '  struct sigaction b;',
          '  b.sa_handler = on_usr;',
          '  sigaction(SIGUSR1, &b, NULL);',
          '  sigaction(SIGHUP, &a, NULL);',
          '}',
        ),
      ),
    )

    // `b` pairs exactly; `a` has no name to pair through, and two signals are in play.
    expect(found).toHaveLength(2)
    const unpaired = found.filter((entry) => entry.signal === '')
    expect(unpaired).toHaveLength(1)
    expect(unpaired[0]!.handler).toBe('on_usr')
  })

  test('a computed handler argument is not a registration', () => {
    const found = registrationsIn(
      candidate('main', source('int main(void) {', '  signal(SIGINT, handlers[i]);', '}')),
    )

    expect(found).toEqual([])
  })

  test('SA_NODEFER is recorded on the registration', () => {
    const found = registrationsIn(
      candidate(
        'main',
        source(
          'int main(void) {',
          '  struct sigaction sa;',
          '  sa.sa_flags = SA_NODEFER;',
          '  sa.sa_handler = on_int;',
          '  sigaction(SIGINT, &sa, NULL);',
          '}',
        ),
      ),
    )

    expect(found[0]!.nodefer).toBe(true)
  })
})

describe('findSignalHandlers', () => {
  const registering = (target: string, signal: string): HandlerCandidate =>
    candidate('main', source('int main(void) {', `  signal(${signal}, ${target});`, '}'), 'src/main.c')

  test('accumulates every signal a handler was registered for', () => {
    // This accumulation is the re-entrancy precondition, not bookkeeping.
    const index = findSignalHandlers([
      registering('sh', 'SIGHUP'),
      candidate(
        'setup',
        source('void setup(void) {', '  signal(SIGTERM, sh);', '}'),
        'src/main.c',
      ),
      candidate('sh', source('void sh(int sig) {', '  return;', '}'), 'src/main.c'),
    ])

    const handler = index.handlers.get(handlerKey('src/main.c', 'sh'))
    expect(handler?.signals).toEqual(['SIGHUP', 'SIGTERM'])
  })

  test('a same-file definition wins over a name reused in another file', () => {
    // `static void cleanup(int)` in two translation units is legal C.
    const index = findSignalHandlers([
      registering('cleanup', 'SIGINT'),
      candidate('cleanup', source('void cleanup(int sig) {', '  return;', '}'), 'src/main.c'),
      candidate('cleanup', source('void cleanup(int sig) {', '  return;', '}'), 'src/other.c'),
    ])

    expect(index.handlers.has(handlerKey('src/main.c', 'cleanup'))).toBe(true)
    expect(index.handlers.has(handlerKey('src/other.c', 'cleanup'))).toBe(false)
    expect(index.ambiguous).toEqual([])
  })

  test('an ambiguous name is dropped and reported, not attached to a guess', () => {
    const index = findSignalHandlers([
      registering('cleanup', 'SIGINT'),
      candidate('cleanup', source('void cleanup(int sig) {', '}'), 'src/a.c'),
      candidate('cleanup', source('void cleanup(int sig) {', '}'), 'src/b.c'),
    ])

    expect(index.handlers.size).toBe(0)
    expect(index.ambiguous).toHaveLength(1)
    expect(index.ambiguous[0]).toContain('cleanup')
    expect(index.ambiguous[0]).toContain('2 files')
  })

  test('a registration naming no known function is reported as unresolved', () => {
    const index = findSignalHandlers([registering('nowhere', 'SIGINT')])

    expect(index.handlers.size).toBe(0)
    expect(index.unresolved[0]).toContain('nowhere')
  })
})

describe('the safety tables', () => {
  test('close is safe and fclose is not', () => {
    // The distinction the table is built on: POSIX lists `close`, and `fclose` is
    // stdio with a buffer behind it.
    expect(isAsyncUnsafe('close')).toBe(false)
    expect(isAsyncUnsafe('fclose')).toBe(true)
  })

  test('the documented replacements for exit are not flagged', () => {
    expect(isAsyncUnsafe('exit')).toBe(true)
    expect(isAsyncUnsafe('abort')).toBe(false)
    expect(isAsyncUnsafe('_exit')).toBe(false)
    expect(isAsyncUnsafe('_Exit')).toBe(false)
  })

  test('the reentrant string variants are left alone on purpose', () => {
    expect(isAsyncUnsafe('strtok')).toBe(true)
    expect(isAsyncUnsafe('strtok_r')).toBe(false)
    // `localtime_r` is not async-signal-safe either, and is still not reported: it is
    // the conventional fix, and dismissing a finding trains the reader to dismiss the
    // next one.
    expect(isAsyncUnsafe('localtime_r')).toBe(false)
  })

  test('longjmp is a jump and not an unsafety', () => {
    // POSIX lists it as async-signal-safe; CWE-364 lists it as its own behaviour.
    expect(isNonLocalJump('longjmp')).toBe(true)
    expect(isAsyncUnsafe('longjmp')).toBe(false)
  })
})
