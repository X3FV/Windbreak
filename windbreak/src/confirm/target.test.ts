import { describe, expect, test } from 'bun:test'

import { planFuzzTarget } from './target'

const base = {
  functionName: 'handler',
  language: 'c',
  cwe: 'CWE-120',
  filePath: 'src/unsafe.c',
}

describe('planFuzzTarget', () => {
  test('emits a target that declares the callee without inventing a signature', () => {
    const plan = planFuzzTarget(base)

    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    // The empty parameter list is the whole trick: in C it means "unspecified
    // parameters", so this links without the parameter list the index lacks.
    expect(plan.source).toContain('extern void handler();')
    expect(plan.source).toContain('handler(input);')
    expect(plan.source).toContain('int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)')
    expect(plan.fileName).toBe('windbreak_fuzz_target.c')
  })

  test('says why it refuses C++ rather than emitting something that cannot compile', () => {
    const plan = planFuzzTarget({ ...base, language: 'cpp' })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    // C has the unspecified-parameter rule; C++ does not, and that is the reason.
    expect(plan.reason).toContain('C++')
    expect(plan.reason).toContain('signature')
  })

  test('refuses a class one run cannot decide, in the class\u2019s own terms', () => {
    const plan = planFuzzTarget({ ...base, cwe: 'CWE-362' })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toContain('race')
    expect(plan.reason).toContain('single run')
  })

  test('refuses a class with no observable recorded at all', () => {
    const plan = planFuzzTarget({ ...base, cwe: 'CWE-9999' })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toContain('CWE-9999')
    expect(plan.reason).toContain('no observable')
  })

  test('refuses when the candidate names no class', () => {
    const plan = planFuzzTarget({ ...base, cwe: null })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toContain('no CWE')
  })

  test('refuses a location with no function to call', () => {
    const plan = planFuzzTarget({ ...base, functionName: null })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toContain('nothing to call')
  })

  test('refuses a symbol-index name that is not a C identifier', () => {
    // The shape that broke the manual harness: a qualified name reaches the
    // emitted file as a syntax error the researcher has to decipher.
    for (const name of ['~Widget', 'Widget::~Widget', 'operator<<', 'ns::Widget::run']) {
      const plan = planFuzzTarget({ ...base, functionName: name })
      expect(plan.ok, name).toBe(false)
      if (plan.ok) continue
      expect(plan.reason).toContain('not a C identifier')
    }
  })

  test('refuses when the candidate records no file', () => {
    const plan = planFuzzTarget({ ...base, filePath: null })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toContain('no source to compile')
  })
})
