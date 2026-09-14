# WindBreak — Blueprint v0.1
### An AI-assisted vulnerability discovery harness for open source codebases

---

## 1. What WindBreak is, and isn't

WindBreak is the standalone successor to the static-scanning module that was spun out of BLACKGATE. Its job is narrow and specific: **find novel, previously-unknown vulnerabilities in open source codebases**, working entirely from clean source (no decompilation — that's HARDLINE's job on closed-source targets). It is a bug-bounty and disclosure tool, not a CI/CD gate — the target user is a solo researcher pointing it at one repository at a time and wanting high-confidence, disclosure-ready findings, not a dashboard of 10,000 lint warnings.

That framing matters because it rules out a lot of the SAST-tool design space. WindBreak doesn't need to be fast enough for a pre-commit hook. It doesn't need a pretty web UI for a team. It needs to be **precise** — every finding that survives to the report stage should be worth the time to read — and it needs to run on a laptop, not a cluster.

**Design philosophy, in one line:** cheap deterministic tools do the wide, boring sweep; expensive LLM reasoning is spent only on the narrow set of candidates that survive it; nothing reaches you without having been argued against by something whose job was to kill it.

---

## 2. The landscape (what already exists, and where WindBreak sits)

This space moved fast in the last year and it's worth knowing who's doing what before designing around it:

- **Google's Big Sleep** (evolved from Project Zero's "Naptime") found the first AI-discovered zero-day in production software — a SQLite buffer underflow that OSS-Fuzz had missed for years. Closed, not something to build on, but the proof of concept that matters.
- **OpenAI's Aardvark**, rebranded **Codex Security**, scanned 1.2M commits in 30 days during early testing and surfaced 22 novel vulnerabilities across projects like OpenSSH and Chromium, alongside thousands of known-severity findings. Also closed.
- **Anthropic's Claude Code Security** launched as a research preview built on Opus-class models, doing similar commercialized vulnerability-discovery work.
- **AISLE** has been running autonomous, continuous analysis against OpenSSL.
- **OpenAnt** (Knostic, Apache 2.0, open source) is the closest public analogue to what WindBreak wants to be: a multi-stage pipeline combining static analysis, LLM reasoning, code decomposition, adversarial verification, and dynamic testing. Worth reading its source directly as a reference implementation.
- **Trail of Bits' Buttercup** — the DARPA AIxCC 2nd-place, now fully open source — is the single most useful architectural reference for WindBreak. It's a four-component multi-agent Cyber Reasoning System (orchestration/UI, contextual analysis, vulnerability discovery, patch generation) that explicitly targets a **single laptop** as a deployment target (also scales to Kubernetes, but laptop is the baseline), pairs static analysis with AI-guided fuzzing, uses **tree-sitter** for program modeling (which you already have a pipeline for), reports in **SARIF**, and — critically — never reports a finding it hasn't reproduced and proven, which is how it hit 90% accuracy at $181/point using non-reasoning models. It found real bugs across 20 CWE categories in targets like the Linux kernel, SQLite, and cURL. It's downloadable and runnable today.
- **KNighter** (SOSP '25, open source on GitHub) solves a different problem that's directly relevant: instead of pointing an LLM at a huge codebase (expensive, impractical), it uses an LLM to **synthesize a narrow, deterministic static checker from a single historical bug-fixing patch**, validates the checker against the original patch, and iteratively refines it to kill false positives. Those synthesized checkers have found 92 new bugs in the Linux kernel (57 fixed, 30 assigned CVEs) — bugs that predefined human-written analyzers missed, with an average latency of 4.3 years. This is the answer to "how do you get LLM-quality pattern recognition without LLM-scale inference cost on every function."
- **KERAT** (USENIX Security '26) is a purpose-built static TOCTOU detector for kernel race conditions: it mines *atomicity rules* about which shared variables/locks must not be touched between a check and its corresponding use, from a corpus of historical patches, then validates new code against those rules using finite state machines. Their own patch study found kernel races are the root cause of 68% of kernel TOCTOU bugs. This is exactly HARDLINE's "check-to-use pattern reasoning" idea, but with a concrete, published static-analysis method behind it.
- **IRIS** demonstrated that combining LLM reasoning with CodeQL detects 103% more vulnerabilities than CodeQL alone — the hybrid approach isn't just intuitively appealing, it's measured.

Nobody has shipped the specific combination WindBreak wants: KNighter-style cheap checker synthesis, feeding a TOCTOU/race-specialized module, feeding a disciplined multi-model adversarial verification stage, running on a laptop, tuned for a single researcher's bounty workflow rather than an enterprise fleet scan. That's the gap.

---

## 3. Why raw "point an LLM at the repo" doesn't work

Worth being explicit about this, because it shapes every downstream design decision. Recent benchmarking is blunt about it:

- On PrimeVul (the highest-quality function-level vulnerability benchmark — real CVEs, vulnerable/patched pairs, low label noise), models that scored 68% F1 on the noisier BigVul dataset dropped to **3% F1**. The earlier numbers were mostly benchmark leakage and noisy labels, not real capability.
- Zero-shot open-weight code models tested against the OWASP benchmark showed false-positive rates near or above **90–99%** — meaning they flag almost everything as vulnerable, which is functionally useless.
- Even frontier models exhibit a **confirmation bias**: one study found up to 93% reduction in detection when the same vulnerable code was framed benignly (e.g., reassuring comments, innocuous variable names) — a 114× stronger false-negative bias than false-positive bias. That means a naive LLM scanner can be trivially blinded by how the surrounding code reads, which is a real concern against real-world open source rather than benchmark snippets.
- The flip side is encouraging: a comparative study of LLM-agent false-positive filtering ("Sifting the Noise") found that agentic filtering *on top of* static-analysis output cut false-positive rates from over 92% down to **6.3%** in the best configuration, and reached a 95.5% false-positive identification rate on a post-cutoff OSS-Fuzz dataset using Claude Sonnet-class models in an agentic scaffold. The catch: this only works well with strong backbone models — weaker models showed inconsistent or negative gains, and aggressive FP suppression can silently eat true positives too.

The takeaway that should drive WindBreak's architecture: **LLMs are much better at judging a specific, already-surfaced candidate than at searching a haystack from scratch**, and even then only the strong models, and even then it needs adversarial framing rather than a single "is this vulnerable?" prompt. This validates the Freebuff/DELTA-style Proposer/Refuter pattern already chosen for HARDLINE — it's not just architectural taste, it's what the data says is necessary.

---

## 4. Architecture

```
                         ┌──────────────────────────┐
                         │   Repo Ingestion Layer     │
                         │ (clone, build graph via     │
                         │  tree-sitter + build system,│
                         │  language/ecosystem detect) │
                         └────────────┬─────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                                     ▼
        ┌───────────────────────┐             ┌───────────────────────┐
        │  Known-Vuln Correlation │             │   Static Detection Core │
        │  (OSV.dev / GHSA query, │             │  - baseline engines     │
        │   dependency + commit   │             │    (Semgrep, tree-sitter│
        │   hash lookups)         │             │     taint pipeline,     │
        │                         │             │     smatch/sparse/      │
        │  → filters out already- │             │     coccinelle for C)   │
        │    known/patched issues │             │  - synthesized checkers │
        │    before spending      │             │    (KNighter-style,     │
        │    compute on them      │             │     mined from patch    │
        └────────────┬───────────┘             │     history)            │
                     │                          │  - TOCTOU/race module   │
                     │                          │    (KERAT-style         │
                     │                          │     atomicity-rule      │
                     │                          │     mining + FSM check) │
                     │                          └────────────┬───────────┘
                     │                                        │
                     └───────────────┬────────────────────────┘
                                      ▼
                         ┌──────────────────────────┐
                         │   Candidate Triage Queue   │
                         │  (fast/cheap-tier Freebuff  │
                         │   model — first-cut noise   │
                         │   filter before full verify)│
                         └────────────┬─────────────┘
                                      ▼
                         ┌──────────────────────────┐
                         │  Adversarial Verification  │
                         │  (Proposer / Refuter,       │
                         │   cross-model corroboration,│
                         │   per BLACKGATE's "never     │
                         │   trust single-model output"│
                         │   principle)                │
                         └────────────┬─────────────┘
                                      ▼
                    ┌─────────────────┴─────────────────┐
                    ▼                                     ▼
        ┌───────────────────────┐             ┌───────────────────────┐
        │  Dynamic Confirmation   │             │      Reporting Layer    │
        │  (optional — PoC/harness│             │  SARIF output +         │
        │   generation, LLM-seeded│             │  disclosure-ready       │
        │   fuzzing for the subset│             │  writeup via Freebuff's │
        │   worth the compute)    │             │  advisory-drafting agent│
        └───────────────────────┘             └───────────────────────┘
```

### 4.1 Repo ingestion & program modeling

Clone the target, detect language(s) and build system, and build a queryable program model rather than treating the repo as flat text. For C/C++ this reuses your existing tree-sitter/taint-tracking pipeline directly — it already transfers to vendor-customized codebases, which is exactly the shape of most bounty targets. Where a build system exists, generate `compile_commands.json` so CodeQL/clang-based tooling can do real semantic analysis rather than falling back to best-effort parsing. Buttercup's contextual-analysis component does exactly this (tree-sitter + CodeQuery to build a queryable model that everything downstream consumes) and is worth reading directly rather than re-deriving from scratch.

### 4.2 Known-vulnerability correlation (do this *first*, it's nearly free)

Before running anything else, query **OSV.dev's API** against the target's dependency manifests and, where relevant, commit hashes. This does two things: catches trivially-known vulnerable dependencies (not the interesting part, but cheap to report), and — more importantly — flags when a candidate finding about to go through triage and verification is actually a rediscovery of something already patched upstream. This is a direct lesson from the WordPress research where a claimed zero-day XSS turned out to be a 2024-patched rediscovery: a two-second OSV/GHSA lookup earlier in the pipeline would have caught it before any writeup time was sunk. OSV's schema is JSON, the API takes a commit hash or package+version and returns matches, and it aggregates GHSA, PyPA, RustSec, and others into one normalized feed — one integration point covers most ecosystems.

### 4.3 Static detection core

This layer is three complementary pieces, not one tool:

- **Baseline engines.** Semgrep (open-core, LGPL engine, fast, YAML rules, 20-30s scans) for broad pattern coverage across languages, plus your existing smatch/sparse/coccinelle stack for C-specific kernel/systems patterns. CodeQL is worth adding for its deeper cross-function/cross-file taint tracking (and its license is free for open-source project analysis specifically, which matches WindBreak's target scope exactly), accepting its longer scan times as a background/nightly-tier job rather than an interactive one. None of these alone are the point — benchmarking shows even four tools combined only catch ~39% of real-world vulnerabilities in isolation, and generic rules on the OWASP benchmark have false-positive rates over 90% before any filtering. They're the wide net, not the catch.
- **Synthesized checkers (KNighter-style).** For a specific target codebase or vendor fork, mine its own patch history (and cross-project CVE-fix corpora — CVEfixes, PatchDB, BigVul) to auto-generate narrow, validated, deterministic checkers for patterns that generic rules don't cover. Each checker is synthesized against a real historical fix, validated to actually catch that fix's bug pattern, and refined to cut false positives — this is how KNighter found kernel bugs with a 4.3-year average latency that human-written analyzers missed entirely. This is the piece that makes WindBreak *learn* a target's specific bug-class fingerprint instead of running the same generic ruleset everyone else runs.
- **TOCTOU/race module.** This is WindBreak's flagship capability, matching your specialty and HARDLINE's already-committed direction. Implement KERAT's approach: mine atomicity rules (which shared variables/locks must not be touched between check and use) from historical patches, encode the four known dangerous check-to-use patterns as finite state machines, and validate new code paths against them, with alias analysis on locks and checked/used variables to keep precision up. This is a genuinely underserved detection category — SonarQube's TOCTOU rule, by comparison, is a much shallower "check-then-use-on-same-path" pattern match without atomicity-rule mining or FSM validation, so there's real room to be better than the closest commercial tool. Feed this module the same logic-flaw-over-memory-corruption priority already decided for HARDLINE.

### 4.4 Candidate triage — cheap-tier Freebuff pass

Every candidate from the static core goes through a single, cheap-tier model call routed through Freebuff (GLM 5.3 Flash is the natural fit, given its already-observed cybersecurity lean) as a fast first cut before anything reaches full adversarial verification. Model access is completely free and time-based, so this stage isn't about managing spend — it's about speed and signal: running the full multi-turn Proposer/Refuter exchange in 4.5 on every single static hit would be slower and would dilute that stage's attention with obvious noise. This is the layer that keeps the more expensive verification stage from drowning in the 90%+ false-positive noise that raw static output produces.

### 4.5 Adversarial verification

Whatever survives the triage pass goes through a Proposer/Refuter pass, mirroring the pattern already built for HARDLINE's DELTA-verify and BLACKGATE's working principle of never trusting a single model's self-report. Concretely: one model argues the finding is real and constructs the exploit reasoning; a *different* model is explicitly tasked with trying to kill it (benign explanation, missing precondition, dead code path, compiler-optimized-away scenario). Model assignment reuses the existing stack — GLM 5.3 Flash's observed cybersecurity lean and triple-checking behavior makes it a strong Refuter candidate; DeepSeek's deep-reasoning-over-large-context strength suits Proposer duty on big codebases; keep it user-selectable per role like HARDLINE rather than hardcoded. This is the step the "Sifting the Noise" benchmark data justifies directly: agentic adversarial filtering on strong backbones is what actually gets false-positive rates down into single digits — a single "is this vulnerable, yes/no" prompt to one model does not.

### 4.6 Dynamic confirmation (optional, second-tier)

For findings worth the extra compute — and only those — generate a minimal harness or PoC and attempt to reproduce the bug, LLM-seeding a fuzzer (AFL++/libFuzzer-style) the way Buttercup does to cut down the time-to-crash. This is the most infrastructure-heavy piece and the most reasonable to defer past MVP or keep manual/semi-automated initially; Buttercup's own discipline of "never report a finding you haven't reproduced" is the right end-state to work toward, but it's also the reason Buttercup took a dedicated team three months to build even with strong fuzzing infra already in hand.

### 4.7 Reporting

Output SARIF as the machine-readable format (same standard OSV-Scanner and Buttercup both use, so tooling interop is free), and generate a disclosure-ready human writeup through Freebuff's existing advisory-drafting agent stub. Given the actual disclosure workflow already in use — GHSA private advisories, Bugcrowd, HackerOne, ZDI, direct maintainer emails — the writeup agent should be schema-enforced (hypothesis / evidence / reproduction steps / suggested fix / CVSS estimate) matching the Reporter module design already specified for HARDLINE's DELTA-tools, so the two pipelines converge on one disclosure format rather than two.

---

## 5. Where Freebuff's existing scaffolding plugs in directly

Freebuff's `.agents/` stubs map onto WindBreak almost without modification:

- **`recon`** → repo ingestion and program-model construction (4.1)
- **`variant-hunting`** → once one instance of a bug class is confirmed (say, a specific TOCTOU pattern or a synthesized-checker hit), sweep the rest of the codebase — and eventually sibling projects in the same vendor-fork family, echoing the OpenWRT/router-fork research direction — for the same pattern. This is also the natural home for "replay this synthesized checker against every other repo WindBreak has already scanned."
- **`advisory-drafting`** → the reporting layer (4.7)
- **`disclosure-tracker`** → tracking which findings went to which platform (GHSA / HackerOne / Bugcrowd / ZDI / direct email) and their status, which is exactly the bookkeeping problem that lost four of the five NetBird findings in the Fedora migration
- **`scope_validator`** (fail-closed) → gates the dynamic-confirmation layer (4.6) specifically, since that's the one component that executes code rather than just reading it

---

## 6. Language/ecosystem phasing

**Phase 1 (MVP): C/C++ only.** This is where your existing tooling (smatch, sparse, coccinelle, the tree-sitter/taint pipeline) and specialty (TOCTOU, kernel-adjacent race conditions) already concentrate, and it's the language KNighter and KERAT were both validated against — the closest fit between prior art and existing skill.

**Phase 2: add whatever the active bounty targets need.** Semgrep and CodeQL both have first-class Python/JS/TS/Go/Java support, so the baseline-engine layer extends cheaply; the synthesized-checker and TOCTOU modules are the parts that need real per-language work and should follow wherever targets actually point (router firmware, VPN/mesh clients, Electron apps are already-scoped directions worth checking against).

**Phase 3: cross-project propagation.** A checker synthesized from one project's patch history gets tried against every other repo WindBreak has scanned — this is the long-horizon payoff of the checker-synthesis investment and where the tool starts finding things no single-repo scan would.

---

## 7. Evaluation & calibration

Before trusting WindBreak's output on a real target, calibrate it against **PrimeVul** — the gold-standard function-level benchmark (real CVEs, vulnerable/patched pairs, deduplicated, low label noise — the benchmark that exposed how much prior numbers were inflated). Track precision/recall/F1 per pipeline stage (raw static hits → post-triage → post-adversarial-verification) so you can see exactly which stage is doing the false-positive-killing work and which stage might be silently eating true positives (a documented risk of aggressive FP suppression). CyberGym (reproducing real memory-safety bugs from crash traces) is a reasonable secondary benchmark once the dynamic-confirmation layer exists.

---

## 8. Deployment & resource plan

Laptop-first, matching both Buttercup's explicit "runs on a laptop" design target and the already-decided HARDLINE pairing (laptop, not the Pi hosting BLACKGATE's dashboard). SQLite-first for state, matching BLACKGATE's existing pattern, rather than standing up new infrastructure. Every model call — triage through final verification — routes through Freebuff the same way HARDLINE and BLACKGATE already do, so there's one place session time is managed rather than three, and no separate local inference stack to maintain.

---

## 9. Open design questions

1. **How much of the dynamic-confirmation layer (4.6) is worth building versus leaving manual for now?** It's the biggest infrastructure lift and the biggest accuracy payoff (Buttercup's whole "never report unreproduced" discipline lives here).
2. **Checker-synthesis time** — synthesizing and refining a KNighter-style checker takes real wall-clock time even though it's free; worth defining a per-target time cap (echoing HARDLINE's delta-budget governor concept, reframed around session time rather than spend) so one stubborn checker doesn't eat the whole session.
3. **Cross-pollination with HARDLINE** — beyond the shared Reporter schema, is there value in WindBreak's synthesized C checkers running against HARDLINE's decompiled output when a target ships both open-source and closed-source components (common in router firmware)?
4. **Variant-hunting scope** — sweep only within one repo, or maintain a standing library of confirmed patterns to replay against every future target from turn one?

---

## 10. Suggested build order

Given the "verification first, false-positive stakes matter most" lesson already applied to HARDLINE's DELTA build order, the same logic argues for building WindBreak's stack in this sequence:

1. **Ingestion + baseline static engines** (4.1, first half of 4.3) — nothing else has anything to work on without this
2. **Cheap-tier triage pass** (4.4) — get the fast Freebuff-routed filter working before the expensive multi-turn one
3. **Adversarial verification** (4.5) — the highest-leverage accuracy piece per the benchmark data in §3
4. **TOCTOU/race module** (second half of 4.3) — flagship capability, but benefits from having 4.4/4.5 already in place to keep its output trustworthy
5. **Checker synthesis** (second half of 4.3) — highest long-term payoff, least urgent for a first working version
6. **Known-vuln correlation** (4.2) — cheap to add at any point, can slot in early opportunistically
7. **Reporting** (4.7) — needed before any real finding leaves the pipeline, so must land before first real target
8. **Dynamic confirmation** (4.6) — last, per the open question in §9

---

## Key references

- OpenAnt (Knostic): https://arxiv.org/abs/2606.19149 · https://github.com — open-source, Apache 2.0
- Buttercup (Trail of Bits): https://trailofbits.com/buttercup/ · https://blog.trailofbits.com/2025/08/08/buttercup-is-now-open-source/
- KNighter: https://arxiv.org/abs/2503.09002 · https://github.com/ise-uiuc/KNighter
- KERAT (TOCTOU/kernel races): https://www.usenix.org/conference/usenixsecurity26/presentation/han
- "Sifting the Noise" (LLM agentic FP filtering): https://arxiv.org/pdf/2601.22952
- IRIS (LLM + CodeQL hybrid): referenced via SecLens survey, https://arxiv.org/pdf/2604.01637
- PrimeVul: https://arxiv.org/abs/2505 (Ding et al., ICSE 2025)
- OSV.dev: https://osv.dev/ · API docs at https://google.github.io/osv.dev/
- Semgrep vs CodeQL comparisons: https://konvu.com/compare/semgrep-vs-codeql

---

*This is a planning document, not a commitment — §9's open questions and §10's build order are the natural next things to pin down.*
