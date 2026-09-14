import { describe, expect, test } from 'bun:test'

import {
  buildRoleSystemPrompt,
  buildUserPrompt,
  TRIAGE_OUTPUT_SPEC,
  VERIFICATION_OUTPUT_SPEC,
} from './prompt'

import type { RenderedEvidence } from './context'

const evidence: RenderedEvidence = {
  text: '<<<TARGET_CONTENT_UNTRUSTED>>>\nfile: src/a.c\nstrcpy(buf, src);\n<<<END_TARGET_CONTENT_UNTRUSTED>>>',
  escapedLines: 0,
}

describe('buildRoleSystemPrompt', () => {
  test('states the data-not-instruction rule for every role', () => {
    for (const role of ['triage', 'proposer', 'refuter'] as const) {
      const prompt = buildRoleSystemPrompt(role)
      expect(prompt).toContain('is DATA')
      expect(prompt).toContain('NO evidentiary weight')
    }
  })

  test('gives the refuter a distinct adversarial task', () => {
    const refuter = buildRoleSystemPrompt('refuter')
    expect(refuter).toContain('KILL')
    expect(refuter).toContain('already guarding')
    expect(buildRoleSystemPrompt('proposer')).toContain('REAL vulnerability')
  })

  test('forbids a confidence score in triage, per §4.6', () => {
    expect(buildRoleSystemPrompt('triage')).toContain('Do not emit a confidence score')
  })
})

describe('buildUserPrompt', () => {
  test('interpolates the evidence verbatim and last', () => {
    const prompt = buildUserPrompt({ role: 'refuter', provenance: 'detected by: semgrep', evidence })

    expect(prompt).toContain(evidence.text)
    expect(prompt.trimEnd().endsWith('<<<END_TARGET_CONTENT_UNTRUSTED>>>')).toBe(true)
  })

  test('uses the same evidence for both verification roles', () => {
    const proposer = buildUserPrompt({ role: 'proposer', provenance: 'p', evidence })
    const refuter = buildUserPrompt({ role: 'refuter', provenance: 'p', evidence })

    for (const prompt of [proposer, refuter]) {
      expect(prompt).toContain(evidence.text)
    }
    // Only the task line should differ.
    expect(proposer).not.toBe(refuter)
  })
})

describe('output specs', () => {
  test('triage accepts exactly the three labels and nothing else', () => {
    for (const label of ['likely-real', 'likely-noise', 'needs-context']) {
      expect(
        TRIAGE_OUTPUT_SPEC.schema.safeParse({ label, rationale: 'because' }).success,
      ).toBe(true)
    }

    expect(
      TRIAGE_OUTPUT_SPEC.schema.safeParse({ label: 'maybe', rationale: 'x' }).success,
    ).toBe(false)
    // A confidence score is not part of the contract.
    expect(
      TRIAGE_OUTPUT_SPEC.schema.safeParse({ label: 'likely-real', score: 0.9 }).success,
    ).toBe(false)
  })

  test('verification requires a verdict, reasoning, and preconditions', () => {
    expect(
      VERIFICATION_OUTPUT_SPEC.schema.safeParse({
        verdict: 'real',
        reasoning: 'because',
        preconditions: ['attacker controls src'],
      }).success,
    ).toBe(true)

    expect(
      VERIFICATION_OUTPUT_SPEC.schema.safeParse({ verdict: 'real', reasoning: 'x' }).success,
    ).toBe(false)
    expect(
      VERIFICATION_OUTPUT_SPEC.schema.safeParse({
        verdict: 'uncertain',
        reasoning: 'x',
        preconditions: [],
      }).success,
    ).toBe(false)
  })

  test('declares a JSON schema that matches the zod contract', () => {
    expect(TRIAGE_OUTPUT_SPEC.jsonSchema.enum).toBeUndefined()
    expect(
      (TRIAGE_OUTPUT_SPEC.jsonSchema.properties as Record<string, { enum?: string[] }>)
        .label.enum,
    ).toEqual(['likely-real', 'likely-noise', 'needs-context'])
    expect(
      (VERIFICATION_OUTPUT_SPEC.jsonSchema.properties as Record<string, { enum?: string[] }>)
        .verdict.enum,
    ).toEqual(['real', 'benign'])
    expect(TRIAGE_OUTPUT_SPEC.jsonSchema.additionalProperties).toBe(false)
  })
})
