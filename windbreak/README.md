# WindBreak

An AI-assisted vulnerability discovery harness for open source codebases.

WindBreak is a laptop-first, CLI-only tool for a solo researcher working a bug
bounty or disclosure workflow, one repository at a time. It works from clean
source only.

**The whole design lives in [`docs/WindBreak-spec.md`](./docs/WindBreak-spec.md)** —
that document is authoritative, and [`docs/Plan.md`](./docs/Plan.md) is the
superseded blueprint it replaces.

## Status

The CLI surface, model policy, credential resolution, and state schema exist.
Every stage in §3.2 is implemented, individually and through `scan`, the pattern
library closes §4.8's loop, patch-mined discovery closes §4.4.1's Phase A,
check-to-use / race detection closes §4.4.3, and `eval` scores a fixture set
against the runs on disk. The program model indexes **eleven languages** rather
than two, which is the half of multi-language support that is about reading a
repository; the detectors that reason about C-shaped defects are still pinned to
C and C++, and each run says how much of the program model that left unswept.
D22's corpus is whole too: `fetch` materializes the snapshots a fixture list names
at their pinned commits, so tier 2 needs no manual checkouts.
**§7.3's command list is implemented.**

`src/investigate/` is §20.29's **investigator** — a model that may read the target and
run commands in it, sandboxed — built through all six of its slices (§20.29.7). It has no
command of its own because it has a *pane* instead: press `c` in the adjudication screen.
Everything it can reach is confined to the checkout and runs in the same sandbox the build
step uses, every result is neutralized before a model sees it, and its prose output cannot
be read as a verdict — it is recorded in `investigator_turns`, a table of its own, and
nothing in the verification path reads that table.

Its findings travel through a fifth tool, `propose_candidate`, and they enter §4.5 as
candidates from the source `investigator`. That source is not decorative. A candidate a
model proposed carries **no detector's provenance**: the model names a location, the file
supplies the text, and the claim is recorded as a claim — so the prompt's provenance line
says `proposed by` rather than `detected by`, the writeup says the same, the SARIF result
carries `properties.modelProposed`, and `eval`'s funnel reports a `modelProposed` column
that says whether the proposals added recall or merely relocated it. A run that used the
investigator is not comparable to one that did not unless that number is read first.

### The investigator pane (§20.29)

Press `c` in the adjudication screen. The pane takes the **body** of the screen (§20.32), with
the queue kept beside it as a narrow rail: a model's answer is a paragraph, so the transcript
**wraps** to the width it is given instead of being cut off at an ellipsis. The trade is
deliberate and is the one thing to know before pressing the key — while the chat is open the
arguments and the decision card are **not on screen**, so the question is asked without the
disagreement beside it. A question is composed against the selected row and the turn records
which candidate it was about, and the rail keeps your place in the queue; `esc` brings the
arguments straight back. A plain question asks about the selected candidate; a line beginning
`/hunt ` asks about the whole target. Escape stops a running turn — or leaves the chat when
nothing is running — so you never leave the screen to cancel one.

On a terminal too narrow to give the transcript a readable width beside the rail, the rail is
dropped and the chat takes the whole screen — a paragraph that can still be read beats a queue
row you can get back with one `esc`.

| key | does |
|---|---|
| `c` | open the chat (refused, and not offered, when no investigator is available) |
| `tab` | switch between the investigator and the engineer — which root the next question is asked of |
| `enter` | send the question |
| `↑`/`↓`, `PgUp`/`PgDn` | scroll the transcript |
| `ctrl+↑`/`ctrl+↓` | move the selection in the queue rail |
| `esc` | stop the turn that is running, or leave the chat |

The hint row under the pane is the chat's own rather than the browse row with a chat segment
appended, because while the input owns the letters the browse keys are **inert**: `r`, `b`,
`a`, `L`, `t` and `q` do nothing here, and a row that named them would be the screen claiming
functions it does not have. `esc` reads as *stop turn* while a turn is running and *leave* when
it is not, and the row drops its least useful keys as the terminal narrows.

The line above the input shows the conversation's budget. A chat is not a scan stage, so
§9's governor does not bound it — instead `investigator.maxConversationCalls` (default
120) caps **model calls in one conversation**, counted from the provider's own usage
reports, with a hunt and an explain drawing on the same budget. It is per *conversation*:
leaving the screen and returning starts a fresh one, and §9's target budget is what spans
runs. A spent ceiling replaces the input with the reason and the way out rather than
silently refusing to accept anything.

What the pane can and cannot do is worth knowing before you trust an answer. The
**investigator** reads the checkout and runs commands in it, **sandboxed with the target
read-only** — it cannot change your code, and its tool list has no write tool in it. What it
says cannot decide anything: it is recorded beside the two arguments and still has to face
triage and verification, and its candidates are labelled as model-proposed everywhere they
appear. Every turn is written to `investigator_turns`.

Press `tab` and you are talking to the **engineer** instead, which edits a writable *copy* of
the checkout — never the checkout itself. The target stays a read-only bind, because the tree
a finding cites has to stay the tree a reader can re-examine. The engineer has
`read_copy_file`, `search_copy_files`, `list_copy_directory`, `run_in_copy`, the three write
tools (`write_copy_file`, `replace_in_copy_file`, `apply_patch_in_copy`) and the same
`propose_candidate`. The copy is made lazily, on the first engineer turn, and re-made per
screen session rather than reused, so a copy that has drifted from the target cannot be
mistaken for it. A write is reported as its own block, one line per file, ending on the
claim the whole design rests on: *the target is unchanged; these edits are in the copy.* The
copy, its base commit, and every file a turn wrote are recorded in `working_copies` and
alongside the turn — a path alone would not do, since the same path is two different trees at
two different times.

It needs credentials and a checkout to read. A **scan** is not required to *read* one: in an
unscanned repository the models read the directory you are in, and the turn says that it is not
being recorded (§20.31). Writing is the part that needs a run — see `tab` and the codebase pane
below. Missing credentials are stated rather than looking ready, and `c` is not offered at all.
Reviewing a disagreement needs no model; only this pane does.

### The codebase pane (§20.30, §20.31)

Press `f` and the file listing takes the detail pane's slot, so the queue and the decision card
stay where they were. For a scanned target it lists the target's inventory — the files **recon
indexed**, so what is on screen is the same set of files the findings are about — with the target
and the pinned commit in its header and each file's language and size beside it. `esc` or `f` goes
back; the arrows and page keys scroll it, and the decision keys are deliberately inert while a
path is being read.

There are two listings and the header says which one you are looking at, because they are
different claims and one of them is much weaker:

| header | what it is |
|---|---|
| `target: …` + `commit: …` | recon's inventory — the files the findings are about |
| `root: … · not scanned · …` | a walk of the checkout on disk — **no finding cites these files** |

The second is what you get in a checkout nothing has scanned, so the screen is useful in a
repository before its first scan — reachable from the start menu's *Files / codebase browser*, which
needs no database at all, or with `f` from the queue once one is open. It is the same walk recon uses (same ignore rules, same 50,000-file
cap), it names the git root — or the directory you are in when there is no `.git` — and it says
outright that a scan is what would make these rows mean something. Nothing else in the screen
pretends they do: the queue beside it is empty because nothing was checked, not because the code
is clean.

A target recon never indexed and a database with no target on record are different facts again,
and the pane says which rather than showing an empty tree: an empty tree looks like a repository
with no files, which is the substitution everywhere else in this tool avoids. Both listings are
capped at 500 displayed rows with the dropped count printed, and a walk that hit its own file cap
says that too — two different ceilings, both reported.

Editing happens against a **copy**, not against the target: see `tab` in the investigator
pane above. The copy is where a patch is written, built and run — patch to test whether a fix
holds, build the vulnerable and patched revisions and compare — while the checkout on disk
stays exactly what was scanned.

What an **unscanned** checkout cannot do is worth knowing before you rely on it. There is no run,
so nothing is recorded: turns are not written to `investigator_turns`, model-proposed candidates
are not created, and `tab` (the engineer) is refused — `working_copies` is keyed by run and
target, and §20.30's engineer is a model whose writes are *recorded*, so with nothing to attribute
a copy to, reading is what remains. Nothing is created to work around that: the screen still
writes no database, which is why a transcript here would need a schema change rather than a
quiet file. The investigator pane says so on the turn.

Building that bridge (credentials, then a second connection to the state database) happens
before the queue is drawn, so a cold start opens on a small **loading view** that names what
it is waiting for — the database when there is one, the repository when there is not — rather
than an alternate screen that looks like a hang. It is not a spinner. See §20.29.8.

| Command | State |
|---|---|
| `windbreak auth status` | working |
| `windbreak config validate` / `show` / `models` | working |
| `windbreak db init` | working |
| `windbreak sandbox check` / `probe` | working |
| `windbreak recon` | working — inventory, revision pin, sandboxed build, program model over eleven languages |
| `windbreak build` (`--dry-run`) | working — the sandboxed build step recon calls |
| `windbreak osv` | working — dependency + commit correlation against OSV.dev |
| `windbreak prepare` | working — resolves engines on the host and reports what the sandbox will bind |
| `windbreak engines` | working — runs the baseline static engines and records candidates |
| `windbreak patch-mine` | working — mines §4.4.1's Phase A shapes from the target's own fix history and sweeps for sibling sites |
| `windbreak toctou` | working — mines §4.4.3's atomicity rules, validates four check-to-use FSMs, and runs four CWE-364 signal-handler shapes over the program model |
| `windbreak pipeline` | working — triages candidates, then cross-model-verifies them |
| `windbreak review` | working — works the human adjudication queue |
| `windbreak report` | working — SARIF, tiered writeups, harnesses, disclosure ledger |
| `windbreak library add` / `list` / `show` / `retire` | working — the cross-target pattern library |
| `windbreak library replay` | working — confirmed-only variant hunting across targets |
| `windbreak scan` | working — §3.2's whole chain over one target, one run, one budget |
| `windbreak resume` | working — continues a run from its first incomplete stage |
| `freebuff windbreak` | working — a start menu (scan / files / resume a run), with the adjudication queue as a screen under it (spec D32, §20.33) |
| `windbreak eval <corpus>` | working — scores recorded runs against repo fixtures (tier 2) or drives the model stages over a function-level pair set (tier 1) |
| `windbreak fetch <corpus>` | working — materializes a fixture list's snapshots at their pinned commits, blobless so the history the miners need survives (D22) |

## Sandboxing

Target code only ever runs inside `nsjail`, or `bubblewrap` when nsjail is not
installed. If neither is present WindBreak stops rather than running anything
unsandboxed.

The target checkout is **never writable**: out-of-source builds get a read-only
bind, in-source builds run against a copy in scratch. The sandbox has its own
network, PID, and user namespaces, so nothing inside it can reach the network
(spec §6.3).

Verify the isolation your machine actually provides, rather than trusting the
flags:

```bash
bun run windbreak sandbox probe
```

```bash
# See the exact sandboxed commands for a target without executing anything
bun run windbreak build --target /path/to/repo --dry-run

# Configure it for real and emit compile_commands.json
bun run windbreak build --target /path/to/repo
```

Note that the sandbox binds only standard runtime directories and pins `PATH` to
`/usr/local/bin:/usr/bin:/bin`. A toolchain installed under `$HOME` (for
example `~/.local/bin` or `~/.cargo/bin`) is deliberately invisible inside it.

## Recon

`windbreak recon` is the ingestion stage (spec §4.1). It inventories the target,
pins its revision, runs the sandboxed build, and indexes symbols and call sites.

```bash
bun run windbreak recon --target /path/to/repo
bun run windbreak recon --target /path/to/repo --no-build --json
```

It produces a `Target` record (id, location, commit, languages, build model,
scope class) and, into the state database, a **queryable program model**:
`recon_files`, `symbols`, and `symbol_refs`, which downstream stages read with
plain SQL.

Two things worth knowing:

- **The commit SHA is read from git's files, not by running git.** `git status`
honours `core.fsmonitor` from an untrusted `.git/config`, which is arbitrary
command execution before any sandbox exists. The dirty check does need git, so
that one runs inside the sandbox.
- **`.c` files are parsed with the C++ grammar.** `@vscode/tree-sitter-wasm`
ships no `tree-sitter-c.wasm`; C++ is a superset of C, so the cpp grammar parses
C cleanly. This is the one grammar compromise, and it is unchanged.

### Languages

The program model covers every grammar the tree-sitter package ships, so the
widening cost no new dependency:

| | | | |
|---|---|---|---|
| C | C++ | Rust | Go |
| Python | Ruby | Java | C# |
| JavaScript | TypeScript | TSX | |

`.tsx` is a **separate grammar**, not a TypeScript mode — the JSX productions
change how `<` parses, so parsing a `.tsx` file with the TypeScript grammar errors
on every component. PHP, shell and assembly are detected and counted, and named in
a warning rather than silently skipped.

Methods are stored as a `method` kind rather than flattened into `function`,
because in nine of these languages most code lives in one: a literal
`kind = 'function'` would find the free helpers and miss the bodies. Everything
that walks the model asks for the callable *set* (`function` or `method`).
Python and Ruby need one extra step — a `def` is only a method because of what
encloses it — so the parser resolves that by walking ancestors until it finds the
nearest callable or container.

What the model does **not** yet do is *detect* in those languages. The five shape
detectors and the check-to-use FSMs are tables of C idioms (`free`/`kfree`,
`mutex_lock`, `access`/`open`, `->`), so they are pinned to `c` and `cpp`. Which
languages each detector has tables for is declared **per detector** in
`src/detectors/capability.ts` rather than as one shared constant, so a language can
be added to one detector without claiming the others can read it — and a language
only some detectors cover is reported as `partly swept`, naming the detectors that
skipped it. The callables they therefore skip are counted and reported, because a
near-empty candidate list on a Python repository must not read as a clean one. The
`scan` summary carries the number as its own line, next to the candidate counts:

```
$ windbreak scan --target /tmp/wb-cov --static-only
candidates:
  from discovery             1
  ...
language coverage: 2 callable(s) swept (c 2); 3 not swept (python 2, rust 1)
```

That `not swept` number is the honest one for the tree, and it sits directly
beneath the candidate count so `0 candidates` cannot be read alone. A third
`partly swept` bucket appears only once the detectors' language lists diverge —
the shipped ones are all `c` and `cpp`, so every language is either fully or not at
all covered today. The stage warnings still name their own narrower skips, and
`--json` emits the same breakdown as `languageCoverage`.

## Known-vulnerability correlation

`windbreak osv` is the §4.2 stage, and it runs **before** the static core
because it is nearly free and prevents spending verification budget on a
rediscovery.

```bash
bun run windbreak recon --target /path/to/repo
bun run windbreak osv --target /path/to/repo
```

It reads the manifests recon located, batches every pinned dependency into one
OSV `/v1/querybatch` request, fetches full records only for hits, and queries
the commit hash as well. Results land in `dependencies` and `osv_matches`, and
the target's `osv_status` records the outcome.

Three behaviours are deliberate and worth knowing:

- **"Could not look" is never reported as "clean".** If OSV is unreachable the
status is `unavailable` and no matches are persisted — the target is
`known_vuln: unknown`, per the spec's failure table. A partial failure is
`partial`, which downstream must also treat as unresolved.
- **Only pinned versions are queried.** A range like `^4.17.0` cannot be
resolved to the installed version, and OSV matches exact versions, so such a
manifest is reported not-checked with the reason instead of guessed at.
- **Dependencies OSV cannot cover are still recorded.** A `pkg-config` `.pc`
file is stored with `queryable = 0` and a reason, so C/C++ library correlation
is visibly missing rather than silently absent.

## Baseline engines

`windbreak engines` is the §4.3 static core. It runs engines as subprocesses
inside the sandbox and normalizes their SARIF into candidates. `prepare`
resolves an engine on the **host** and reports the roots the sandbox will bind,
because the sandbox deliberately binds neither `$HOME` nor `~/.local` where a
user-level install lives.

```bash
bun run windbreak prepare                     # resolve engines, list binds + rules
bun run windbreak engines --target /path/to/repo --yes
```

Only Semgrep is driven so far; the other §4.3 engines are recognized and
reported as not-run rather than silently skipped. Three behaviours worth
knowing:

- **A killed engine is not a clean engine.** If the sandbox's memory limit kills
`semgrep-core`, Semgrep still emits valid-but-empty SARIF. The adapter reads
`invocations` for that and marks the run failed; `--jobs` defaults to `1` for the
same reason.
- **Configuration is fail-closed.** A configured engine that cannot be resolved
stops the stage instead of thinning the net. `prepare` exits non-zero when
nothing resolves.
- **The §9 budget governor runs the stage.** Each stage gets its share of the
target budget; an overrun degrades with `--yes` or prompts interactively, and
every decision is recorded in `budget_events`.

## Patch-mined discovery

`windbreak patch-mine` is §4.4.1's Phase A, the recall mechanism the spec adds on
top of the engines (D5). Instead of inventing rules, it reads the target's **own**
fix history, extracts the *shape* of each fix — a null check, a bounds check, a
return-value guard, a lock, a lifetime change — and sweeps the current tree for
sibling sites that still have the pre-fix shape.

```bash
bun run windbreak patch-mine --target /path/to/repo --yes
```

On a repository whose fix commit guards one of two functions, the pattern comes
from the fix and the candidate comes from the *other* function:

```
patterns (§4.4.1 — each validated against its own patch):
  pm_4226a7ee6dde5f59  null-check    1x  strcpy       unsafe.c

sibling sites:
  unsafe.c:11  paste  — `dst` is used by `strcpy` with no null test
```

**A pattern is only emitted if it explains its own patch.** That is §4.4.1's rule
and the only gate there is: the shape detector must fire on the patch's pre-image
and not on its post-image, and a hunk that fails is *dropped*, not tuned. The
command prints why each hunk was dropped, because "the detector fired on the fixed
code too" and "the detector never fired at all" are different failures.

Four things worth knowing before reading a result:

- **These are candidate generators, not rules.** No dataflow, no alias analysis.
Validation proves a pattern describes the fix it came from; it does not prove the
pattern is precise. Triage and cross-model verification are what judge it, so a
patch-mine run on its own is not a findings list.
- **Only an explicit `NULL`/`nullptr` counts as a null test.** `if (p == 0)` is a
null check in C and is deliberately not read as one: accepting `0` would validate
null-check patterns about integers, and a false pattern that passes the only gate
is worse than a missed one.
- **The sweep is scoped to the mined call.** Siblings are functions that call the
*same callee the fix was about* — that is what makes the result patch-mined rather
than a stock linter. A shape with no call to scope by is dropped.
- **Mining never fails a scan.** A target that is not a repository, an unreadable
history, or a missing program model each produce a warning and an empty result.
`git` runs inside the sandbox, one spawn for the whole history walk, capped by
`--max-commits` and restricted to C-family paths.

## Check-to-use and races

`windbreak toctou` is §4.4.3, the sibling of patch-mined discovery one section
later in the spec. It runs three producers over the same function set, and they are
worth keeping apart because they answer different questions:

- **Mined atomicity rules** — "which shared variable must not be touched without
  which lock". These come from the target's own lock-adding commits, so a rule is a
  claim about *this project* rather than about C. Every rule carries the SHA that
  established it.
- **Four check-to-use FSMs** — `path-check-then-use`, `double-fetch`,
  `lock-scope`, `lifetime-race`, each a statement about *ordering*: a check, then
  something, then a use.
- **Four CWE-364 signal-handler shapes** — `unsafe-call`, `reentrancy-window`,
  `shared-state`, `non-local-jump`. These are the one family the four FSMs cannot
  express: a signal-handler defect does not happen *between* two statements in one
  function, it happens because the function is running while something else is midway
  through its own work. So the interruption is the middle of the traversal and it is
  nowhere in the source. They run only on functions a *registration* identifies as
  handlers.

```bash
bun run windbreak toctou --target /path/to/repo --yes
```

On a repository whose second commit takes a mutex it was not taking before, in one
of two functions that touch the same global:

```
atomicity rules (§4.4.3 — mined from lock-adding hunks):
  ar_491eeeb008a2039e  g.hits   requires g.mu  1x  src/srv.c

check-to-use sites:
  src/srv.c:24  load  [path-check-then-use] `path` is checked at line 23 and
                re-resolved at line 24; the name can be bound to a different
                object than the one the check saw

atomicity violations:
  src/srv.c:19  read_unguarded  `g.hits` is accessed at line 19 with `g.mu` never
                held in this function (atomicity rule ar_491eeeb008a2039e, mined
                from d2fa956e0a9f in src/srv.c)
```

`bump_guarded`, which takes the lock the fix added, produces **no** violation.
`read_unguarded`, which does not, produces one. That separation is the whole point
of mining rules instead of assuming them.

On a target whose handler is CERT SIG30-C's own noncompliant example — freed in the
handler, cleared afterwards, registered for two signals:

```
signal-handler races (CWE-364):
  main.c:18  handler  [reentrancy-window] `logMessage` is released at line 17 and only
             cleared at line 18; the handler is registered for `SIGHUP` and `SIGTERM`,
             so a second delivery re-enters inside that window and releases it again
  main.c:16  handler  [unsafe-call] `syslog` is called at line 16 in a signal handler
             registered for `SIGHUP` and `SIGTERM`, and it is not async-signal-safe: the
             signal can arrive while that function is mid-update, so the handler runs
             against state it was never written to share
  main.c:14  handler  [shared-state] `g_stop` is written at line 14 in a signal handler
             registered for `SIGHUP` and `SIGTERM` and read at main.c:25 in `main`; it is
             not `sig_atomic_t`, so whichever runs is interrupted mid-update and sees the
             other's half-finished value
```

The three shapes are three different fixes: don't free in the handler, don't call
`syslog` from it, and make the flag the type the language provides for exactly this.
The second source file in that target is the control — a function that sets a global
from a handler body produces nothing because nothing registers it, a
`volatile sig_atomic_t` flag produces nothing because it is the fix, and a global
shared between two ordinary functions produces nothing because neither is a handler.

Five things worth knowing before reading a result:

- **These are candidates, not findings, and only the signal shapes claim a CWE.**
  §4.4.3's priority is *logic flaw over memory corruption*, so a lock-scope or
  atomicity candidate is not filed under a corruption class. The signal shapes name
  CWE-364 and CWE-828 because MITRE names them — an async-unsafe call *is* CWE-828 by
  its own entry, not by analogy. A race needs a human, which is what the framing is
  for.
- **Every ambiguity resolves toward reporting less.** The alias analysis is a
  precision instrument: expressions that don't resolve to the same object don't
  alias, and a check and a use both inside one held lock are the *fix*, not a race.
  Two pointers that are equal at runtime are still two keys here.
- **The four FSMs are our reading of "the four known patterns".** §4.4.3 uses a
  definite article and never lists them, so §20.22.1 of the spec records which four
  this build chose and why. That is the one interpretation in this stage — the
  CWE-364 shapes carry no such caveat, because MITRE enumerates those itself.
- **The signal shapes only fire on a function *something registers* as a handler.**
  A handler is a handler because another function said so, so that pre-pass reads
  every indexed function; `--no-signal` declines it. A second gate is worth knowing:
  an object declared `volatile sig_atomic_t` is the documented fix, so it is never
  reported — as with everything here, the analysis is built to stay quiet about the
  cure.
- **All producers run even when the history can't be read.** The FSMs and the signal
  shapes need no git; a target that is not a repository still gets swept, and the
  warning says which half was unavailable.

## Candidate pipeline

`windbreak pipeline` is the first stage that sends target text to a model, so it
is also where the trust boundary (spec §5) becomes real. It consumes the
candidates `engines` recorded and runs, in order: a rediscovery pre-check, triage
(§4.6), then Proposer/Refuter cross-model verification (§5.2).

```bash
bun run windbreak recon    --target /path/to/repo
bun run windbreak engines  --target /path/to/repo --yes
bun run windbreak pipeline --target /path/to/repo --yes
bun run windbreak review
```

It attaches to the run `engines` created rather than starting a second one, so
one target scan keeps one run row and one budget.

Five behaviours worth knowing:

- **Disagreement goes to a human, not to a third model.** real+real survives,
benign+benign is dropped, and any disagreement lands in the adjudication queue
with both arguments. `windbreak review` resolves it; a non-interactive run lists
the queue rather than deciding on your behalf.
- **A model failure is never a clean result.** A failed call leaves the candidate
untriaged or triaged — never dropped, never verified — and the run is reported
`partial`.
- **Instruction-like target text is neutralized, not deleted.** Lines matching
injection markers are wrapped in `<untrusted-escaped>` and the prompt states
that the fenced block is data. Proposer and Refuter receive byte-identical
evidence, so their disagreement is about reasoning, not framing.
- **Reproducibility comes from the verdict cache, not from the provider.** The
SDK's agent path cannot set a seed, so every verdict records
`seed_supported: false`; re-running the same target replays recorded verdicts.
Use `--no-cache` to force fresh calls.
- **A rediscovery is matched conservatively.** A candidate is only routed away
from verification when an advisory actually names its file or a project symbol;
a shared CWE alone is never enough, because a wrong match silently loses a real
finding.

The pipeline needs the public client environment the codebuff CLI uses, and it
supplies it itself: `src/pre-init/client-env.ts` fills in any `NEXT_PUBLIC_*`
value the shell did not set, from the same table the shipped binaries carry
(`@codebuff/common/client-env-defaults`). Nothing has to be exported to run from
a checkout:

```bash
bun run src/index.ts pipeline --target /path/to/repo --yes
```

An explicit value still wins, which is the supported way to point a run
somewhere else:

```bash
NEXT_PUBLIC_CODEBUFF_APP_URL=https://staging.example bun run src/index.ts pipeline ...
```

## Reporting

`windbreak report` is the §13 stage. It makes **no model calls** — the narrative
is composed from the verdicts the pipeline already recorded — and it writes
SARIF 2.1.0, one tiered writeup per finding, and a reproduction harness per
finding.

```bash
bun run windbreak report --target /path/to/repo

# Say you reproduced one outside WindBreak: it gets the stronger tier
bun run windbreak report --target /path/to/repo --reproduced <candidate-id>

# The disclosure ledger, without writing a report
bun run windbreak report --ledger
bun run windbreak report --set-status submitted --finding <finding-id> --channel email
```

Four behaviours worth knowing:

- **The evidence tier is derived, never guessed, and never omitted.** A confirmed
candidate is `statically-verified`, an unresolved disagreement is `contested`,
and anything that has not survived verification is excluded *with a reason*
rather than dropped silently. The writeup renderer refuses to emit a claim whose
tier is unstated (spec §2.1.5).
- **Harnesses are generated and never run (D21).** Each one states its expected
observable failure and leaves TODO markers for the parts only you can supply. The
emitted skeleton is verified to be valid C — the test suite compiles every shape
the generator can emit — but it declares its own prototype, so it does not link
until you add the real header and signature.
- **Artifacts are private.** The output directory is `0700` and every file
`0600`, because writeups carry live exploit detail. Nothing is uploaded;
submission is manual and tracked in the ledger.
- **Re-running reporting does not rewind disclosure state.** A finding you have
already marked `submitted` stays `submitted`.

## Pattern library and variant hunting

Once a finding is confirmed, `windbreak library add` generalizes it into a
**fingerprint** — a small set of call-presence predicates over a site — and
stores it. `windbreak library replay` then sweeps that pattern across another
target. This is §4.8's payoff: a confirmed bug stops being one finding and
becomes a search across every codebase the researcher already has indexed.

```bash
# After `report --reproduced` has recorded the human-reproduced tier
bun run windbreak library add --candidate <candidate-id>

bun run windbreak library list
bun run windbreak library show <checker-id>

# Sweep a second target
bun run windbreak library replay --target /path/to/other-repo

# §10's silence check, when the fixed revision is available
bun run windbreak library replay --target /path/to/other-repo --post-image <target-id>

# A noisy pattern is retired, never deleted
bun run windbreak library retire <checker-id>
```

A fingerprint is **data, not code**: predicates like "calls `strcpy`, calls
none of `strncpy`/`snprintf`/`strlcpy`" are validated against a strict schema
and then evaluated with plain SQL over the target's program model. There is no
subprocess, no model call, and no filesystem read at replay, so a sweep is cheap,
reproducible, and cannot execute anything. The model is asked exactly one
question — which predicates describe this confirmed site — and the answer is
checked against the site it came from before it is stored.

Six behaviours worth knowing:

- **Three gates stand between a finding and a library pattern.** The candidate
must be `confirmed`, the pattern must reproduce the site it was mined from
(dropped, not tuned, if it cannot), and §10's post-image check must pass when a
post-image is supplied.
- **`confirmed` admits a pattern; the evidence tier gates its replay.** A pattern
seeded by a human-reproduced finding replays freely. One whose seeding finding
only cleared model verification is stored `unconfirmed` and refused at replay
unless `--allow-statically-verified` is passed. The refusal names the tier.
- **A pattern that drifts is skipped, not repaired.** Revalidation requires a
hit at the recorded origin *site*, not merely somewhere in the file — a pattern
that has widened onto unconfirmed code is exactly the failure this catches.
- **Post-image silence is reported honestly.** The check is recorded as passed,
failed, or *not run* — `null` is a distinct answer, because a check that did not
happen must never be presented as one that did.
- **A broad pattern is bounded and named.** Each pattern is capped per sweep and
the cap warns that the pattern is broader than the bug it came from, so a sweep
stays reviewable.
- **Precision is computed live** from the candidates a pattern has actually
produced, so the figure you retire a pattern on is current rather than a
snapshot from sweep time.

## The start menu, and the adjudication screen

Typing `windbreak-tui` — or `freebuff windbreak`, where the freebuff on PATH carries the
screen — opens a **start menu** for the checkout it was run in (spec §20.33):

```
WindBreak  /home/researcher/project-a
╭─ WindBreak ────────────────────────────────────────────────────────╮
│   Run a scan on this repo                                          │
│     recon → engines → OSV → triage → verification → report, in     │
│     …/projects/project-a                                           │
│ ❯ Files / codebase browser                                         │
│     the files this repository holds, and which of them a scan      │
│     indexed                                                        │
│   Resume a previous run                                            │
│     2 runs · 3 undecided disagreements                             │
╰────────────────────────────────────────────────────────────────────╯
 ↑↓/jk choose · enter select · q quit
```

Three things it does that the batch commands cannot. **A scan runs here**, in the
same process, streaming the run's own log and then keeping its summary on screen
— `enter` opens the queue for the run it produced. **The files open before any
scan has run**, because listing a checkout never needed one (§20.31). And
**`resume a previous run` lists the database**, newest first, with the first row
being *every disagreement* across all of them; `r` continues an incomplete run
from its first unfinished stage.

A row that cannot be taken stays on screen with its reason under it rather than
disappearing, and a row that is merely empty is still offered — *this database
holds no runs yet* is a different statement from a row that is not there.

**Leaving the scan screen leaves the command.** The scan is in-process, so `esc`
and `q` quit rather than returning to the menu; the run that got as far as it got
stays in the database and `r` continues it.

The queue is a screen *under* the menu, reached through a run — or reached
directly by naming one, which is what a scripted invocation wants:

```bash
# From the repo root. The screen reads the same state database as the commands.
bun run cli/src/entry.ts windbreak --db /path/to/.windbreak/state.db

# `--run` skips the menu and opens that queue, as it always did
freebuff windbreak --run <run-id> --all
```

Once the queue is open, the two commands above resolve a queue entry with flags,
and this screen is for when you would rather read the case than type a decision —
it ships inside the freebuff CLI, which already carries the OpenTUI/React stack
the spec's D32 chose for it.

Both forms need the current code: `freebuff windbreak` runs the **installed
binary**, so a change to the screen is invisible there until
`cli/scripts/build-binary.ts` produces a new one. `bun run …entry.ts` always runs
what is on disk — reach for it when editing the screen, and rebuild when you want
the bare `windbreak` command to match.

**A rebuild must carry the public client env, or the binary dies on startup.**
`build-binary.ts` inlines every `NEXT_PUBLIC_*` value present in the *builder's*
environment with `--define`; a build with none of them set produces a binary that
fails `@codebuff/common/env`'s import-time validation with a zod dump before
`main` — and `applyClientEnvDefaults` deliberately skips a compiled binary, so
there is no runtime fallback. The checked-in table the release build's values live
in is `common/src/client-env-defaults.ts`, so export it before building:

```bash
cd freebuff
while IFS= read -r line; do [ -n "$line" ] && export "$line"; done <<< "$(bun -e '
const m = await import("./common/src/client-env-defaults.ts")
for (const [k, v] of Object.entries(m.CLIENT_ENV_DEFAULTS)) if (v) console.log(`${k}=${v}`)
')"
cd cli && bun run build:binary
```

**`build:binary` builds Freebuff.** `IS_FREEBUFF` is a compile-time constant read
from `FREEBUFF_MODE`, so the variant is a build decision rather than a runtime one:
this checkout's `build:binary` sets `FREEBUFF_MODE=true` and names the output
`freebuff`. `build:binary:codebuff` is the Codebuff product's own build — its
output reports `Usage: codebuff`, brands itself Codebuff, and keeps the `publish`
command that `FREEBUFF_REMOVED_COMMANDS` exists to drop. It makes no difference to
`windbreak`, whose surface is handled before commander parses argv, but it is the
difference between running Freebuff and running a Codebuff build with a Freebuff
path shim in front of it.

Then copy `cli/bin/freebuff` over the installed binary. Three things bite here, and
all three cost a debugging session:

- **`cp` onto a binary that is currently running fails with `Text file busy`.**
  Copy beside it and `mv` into place, which replaces the directory entry and
  leaves the running process on its old inode.
- **The npm wrapper re-downloads over a local build.** `freebuff` on `PATH` is the
  published wrapper, not this binary: it launches `~/.config/manicode/freebuff`
  and, on every start, compares the version in
  `~/.config/manicode/freebuff-metadata.json` against the latest npm release,
  replacing the binary if the release is newer. A local `1.0.0` build against a
  `0.0.x` release line is *older* by that comparison, so the metadata has to be
  written too — otherwise the wrapper silently restores the stock binary and your
  change disappears.
- **`tree-sitter.wasm` has to be copied beside it**, and kept in sync with the
  build.

```bash
CFG="$HOME/.config/manicode"
cp cli/bin/freebuff "$CFG/freebuff.new" && chmod 755 "$CFG/freebuff.new"
mv -f "$CFG/freebuff.new" "$CFG/freebuff"
cp cli/bin/tree-sitter.wasm "$CFG/tree-sitter.wasm"
printf '{\n  "version": "1.0.0",\n  "target": "linux-x64"\n}\n' > "$CFG/freebuff-metadata.json"
```

The metadata version must match what the binary reports (`--version`) and sort
above the npm release line; `1.0.0` does both while the package is `0.0.x`. If the
wrapper ever does replace the binary, `freebuff-metadata.json` is what to look at
first — and `~/.config/manicode/freebuff.stale` is where it parks the one it
replaced.

Two shims put the screen on your PATH, and they differ in which copy of the code runs:

```bash
# this checkout, from source — what to use while editing the screen
ln -sf "$PWD/scripts/windbreak-tui" ~/.local/bin/windbreak-tui

# a screen that lives inside an installed freebuff; forwards to `freebuff windbreak`
install -m 755 scripts/windbreak ~/.local/bin/windbreak
```

**`windbreak-tui` is a symlink because it runs this checkout's source**, so the link keeps
it pointed at the code you are editing and an edit is live on the next run with no
reinstall to forget. A copy works too, with `WINDBREAK_ROOT=<checkout>` exported — copied
away from the checkout, the script has no path back to it, and says so rather than guessing.

The same is true of `scripts/windbreak` where it applies, but on this checkout's freebuff
release line it does not: `0.0.174` has no `windbreak` subcommand, and while the screen is
being edited the installed binary is the *old* screen by definition. That is the whole
reason `windbreak-tui` exists. Neither name is installed as a bare `windbreak` — the two
names say which program you are getting.

`windbreak-tui` opens on the target it runs *from*: `$WINDBREAK_TARGET`, else the checkout
it belongs to. The screen's own rule is the directory you are in, which is the same answer
when you are in the checkout. It resolves no database of its own either: the screen reads
the checkout's own `.windbreak/state.db`, or the one that checkout's config names, so it
opens from anywhere inside a scanned project rather than only from its root. With nothing
to read it opens on the repository you are in instead — the file pane lists your checkout,
marked as unscanned (§20.31) — so it is useful in a fresh clone rather than only after a
scan:

```
 WindBreak adjudication  …/.windbreak/state.db
╭─ Queue — 2 ────────────────────╮╭─ src/handler.c:6  lines 1–12/31 ─────────╮╭─ Decision ─────────────────╮
│ ❯ src/handler.c:6  CWE-120  s… ││ semgrep/wb-c-unbounded-string-op        ││ entry                      │
│   src/parse.c:12  CWE-120  v… ││   strcpy(buf, line);                    ││   cand-1  escalated        │
│                                ││ ⚠ 1 instruction-like line neutralized   ││   src/handler.c:6          │
│                                ││ ─────────────────────────────────────── ││   semgrep/wb-c-unbounded-s │
│                                ││ proposer openai/gpt-5 (openai) → real   ││   tring-op                 │
│                                ││   the length check runs after the copy  ││ ────────────────────────── │
│                                ││   preconditions (2):                    ││ decision                   │
│                                ││     - argv[1] can exceed 31 bytes       ││   none staged — r real, b  │
│                                ││ ─────────────────────────────────────── ││   benign                   │
│                                ││ refuter z-ai/glm-5.3 (z-ai) → benign    ││ ────────────────────────── │
│                                ││   every caller in this revision         ││ last                       │
│                                ││   validates the length first            ││   nothing recorded yet     │
╰────────────────────────────────╯╰─────────────────────────────────────────╯╰────────────────────────────╯
 ↑↓/jk move · wheel scrolls · PgUp/PgDn argument · r real · b benign · a all · L auto · t default · q quit
```

`r` and `b` stage a decision — the card shows what is staged and `Enter` records
it. The rationale is optional, and the screen says so when you skip it.

The arguments can be longer than the pane — `detail` is wrapped before it is
rendered, so the border title carries the position (`lines 31–61/71`) and the
pane scrolls by wheel or `PgUp`/`PgDn`. The queue is clickable: hover highlights
a row, a left click selects it, and moving the selection resets the detail's
scroll, because a view position means nothing on a page of different text.

## Shaping the screen

The screen is three panes — queue, argument, decision — and degrades to two and
then to a stack as the terminal narrows. The argument keeps its column longest:
the queue is a fixed shape and the card is a handful of fields, while every
column a wrapped sentence does not get is a line you scroll.

Two keys change how it looks, and the choice is written to the CLI's settings
file (`~/.config/manicode…/settings.json`) so it survives the run:

- **`L`** walks the arrangements: `auto` → `three panes` → `queue + detail` →
  `stacked`. `auto` is the default and degrades on its own; the others pin an
  arrangement, which still degrades rather than drawing a pane zero columns wide.
- **`t`** walks the palettes: `default` (the CLI theme as-is), `contrast` (chrome
  and secondary prose raised to full foreground, for terminals where `muted` is
  unreadable) and `reading` (frames and evidence recede so the arguments carry
  the colour).

Every element the screen paints has a name, and every name can be pinned:

```json
{
  "windbreak": {
    "layout": "columns",
    "theme": "default",
    "queueWidth": 34,
    "decisionWidth": 30,
    "colors": {
      "detailRule": "#ff00ff",
      "headerText": "#00ff00",
      "realText": "#ff5555"
    }
  }
}
```

The names are element names — `frame`, `frameFocused`, `title`, `headerText`,
`headerMeta`, `queueText`, `queueSelectedFg`, `queueSelectedBg`, `queueHoverBg`,
`queueResolvedText`, `queueMoreText`, `detailText`, `detailMuted`, `detailRule`,
`evidenceText`, `warningText`, `realText`, `benignText`, `roleLabel`,
`decisionLabel`, `decisionIdle`, `decisionNotice`, `decisionError`,
`decisionReal`, `decisionBenign`, `decisionMeta`, `rationaleBg`, `inputFg`,
`hintsText` — and overrides apply per key, after the variant. A name that is not
in that list is ignored, and nothing is hard-coded to a hex: a variant points at
the CLI theme's own tokens, so switching the CLI to a light theme gives you a
light adjudication screen for free.

Four things it refuses to fudge:

- **A missing database is not an empty queue.** Pointing `--db` (or the walk-up
  default) at a path that does not exist still opens the screen — a one-line
  error followed by no screen is a poor way to name a state the screen can
  explain — but the header marks the path `· not found` and the queue pane says
  *nothing has been scanned here*, never "nothing is queued". Nothing is created
  on the way, so an empty queue always means an empty queue.
- **Both arguments come with the model that made them.** §5.2's gate assumes the
two sides came from different providers, so the providers are on screen.
- **The evidence is shown before the arguments**, and §5.1's neutralized
instruction-like lines are shown too: a target that tried to steer a model is
evidence about the finding, not a detail to hide.
- **Re-deciding says what it replaced** ("was benign, changed") rather than
quietly overwriting. Decisions are written by the pipeline's own
`recordAdjudicationDecision`, so the screen and `windbreak review --decide`
produce the same record.

## Scanning a target end to end

`scan` runs §3.2's chain — recon, OSV, the static core (baseline engines, patch
mining, check-to-use), variant hunting, triage, verification, reporting — in one
invocation, against one run and one budget:

```bash
bun run windbreak scan --target /path/to/repo --yes

# Discovery only: no model calls, so it works before credentials do
bun run windbreak scan --target /path/to/repo --static-only --yes

# Continue whatever the last scan could not finish
bun run windbreak resume --run <run-id> --target /path/to/repo --yes
```

The individual stage commands remain, and they are the right tools for looking
at one stage in isolation. `scan` differs from running them in sequence in three
ways worth knowing:

- **One run, one budget.** The stage commands each create their own run row,
which is right when used alone. §9's budget is *per target* and §11.3's metrics
are *per run*, so a scan creates one run and threads one governor through every
stage.
- **Discovery degrades; sandboxing does not.** With no model environment the
scan still performs discovery and writes a report, marking itself `partial` and
exiting non-zero rather than pretending the chain ran. A sandbox it cannot get,
or an engine it cannot resolve, is a hard stop — continuing would mean running
target code unsandboxed or reporting a thinner net than was asked for.
- **Progress is written after every stage**, so a scan cut short by Ctrl-C, a
failure, or the budget leaves a resumable record. A resume re-runs only what is
not complete, inherits the original budget and mode flags (an explicit flag
still wins), and does not repeat stages that already finished.

`--update-library` is the one opt-in step: it also generalizes this scan's
confirmed findings into library patterns, at one synthesis call per finding.

## Stage boundaries

Every stage's options type is the intersection of a serializable **request** and
its injected **services** — `RunTriageOptions` is `TriageRequest &
TriageServices`, not a flat interface:

```ts
const { request, services } = splitStageOptions<TriageRequest, TriageServices>(
  HANDOFFS.triage,
  options,
)
```

This is the precondition §20.17.3 named for a future subprocess transport, and
it is deliberately the *only* part written — the transport is still deferred
(§20.17), and `scan` composes stages in-process exactly as before. What it buys
today is a fact that does not depend on the boundary existing: the request half of
any stage can cross a pipe, and the type system enforces it.

Two compile-time guards in `src/pipeline/handoffs.ts` keep the split from rotting.
A request half that acquires anything JSON cannot carry — a `Database`, a
callback — fails the typecheck, and the error names the offending field
(`{ notSerializable: 'db' }`) rather than just failing. A field added to a stage's
interface without being placed in a half fails the build too. Neither guard costs
runtime code; both are asserted while typechecking, not while running.

The intersection shape is what made this affordable: an options object written
before the split still compiles, so the seam added zero call-site churn. The
package's `pipeline/handoff` module also has `encodeRequest`/`decodeRequest`, a
JSON codec with no framing or channel — enough to prove the claim, not enough to
be a transport.

## Scoring a run against ground truth

`windbreak eval` answers the question nothing else in the pipeline can: does this
configuration actually find the bugs it is supposed to. It reads runs that are
already recorded — no model call, no network — and scores them against a fixture
list (spec §11).

A fixture list is ground truth: a pinned **vulnerable** commit, the bugs seeded in
it, and optionally the commit that fixes each one. Snapshots are fetched on demand
(D22), so the list stays in-repo while the code does not — `windbreak fetch` is
the command that does it, below. Copy
[`docs/eval-fixtures.example.json`](./docs/eval-fixtures.example.json) to start.

```bash
windbreak fetch fixtures.json --into .windbreak/snapshots   # D22: the snapshots
windbreak scan --target .windbreak/snapshots/libarchive-6a7b8c9d0e1f
windbreak eval fixtures.json --db .windbreak/state.db
windbreak eval fixtures.json --min-recall 0.5     # a stricter gate
windbreak eval fixtures.json --run run_168ab      # score one run only
windbreak eval fixtures.json --json               # for a harness
```

The join key is the **commit SHA**. A fixture is scored against the newest run
whose recorded commit matches it, and a fixture with no such run is reported as
unscored rather than as a zero — "this was not measured" and "this measured
zero" are different claims.

```
demo-target  demo @ abc123def4567890abc123def4567890abc12345
  run: run-1   seeded: 3 bug(s)

  stage              cands  tp  fp  unscored  precision  recall  discovery  target fp
  ─────────────────  ─────  ──  ──  ────────  ─────────  ──────  ─────────  ─────────
  raw static hits        5   2   2         1      0.500     1/3        1/3        90%
  post-triage            3   1   1         1      0.500     1/3        1/3        60%
  post-verification      2   1   0         1      1.000     1/3        1/3        25%
  post-adjudication      1   1   0         0      1.000     1/3        1/3        10%

never-scanned  demo @ 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c
  NOT SCORED  no run in the database is pinned to 9f8e7d6c5b4a…, so nothing
              has been scored against this fixture

surfaced      0.333 (mean over scored fixtures)
  discovery   0.333
gate          PASS  >= 0.20 (D11)
```

Three rules keep those numbers honest, and each is the §18 rule applied to a
score:

- **A stage that did not run carries no numbers at all** — em dashes, not zeroes.
  A zero would mean "this stage ran and killed everything", which is the most
  interesting row in the report and the opposite of an absent one.
- **A fixture with no matching run is unscored**, and a candidate that matches no
  seeded site is counted as a false positive *with a standing caveat* that it may
  be a real bug the list does not seed. Precision here is a lower bound.
- **A candidate with no file path is neither.** It is counted as `unscored`,
  because a hit nothing can be said about is not evidence of noise.

`bugsLost` names the seeded bugs a stage stopped representing, which is how
§11.4's "a recall drop between triage and verification means the Refuter is
over-killing" becomes answerable rather than a topic for further investigation.
Two recall figures are reported because they answer different questions: the
`discovery` column excludes bugs surfaced only by OSV correlation, and correlation
finding a bug the fixture list already knew about says nothing about the engines.

Exit codes, so this can gate CI: `0` only on a pass. A failed gate exits 1, and so
does a run that **could not be evaluated** — a pipeline that was never measured
must not report success.

### Fetching the snapshots (D22)

D22 splits the corpus: the list is private and lives in-repo, the snapshots are
fetched at run time. `windbreak fetch` is that half, and it is its own command
rather than a flag because `eval` is documented above as offline and free, and a
clone behind the command you re-run to re-score yesterday's corpus would make that
false.

```bash
windbreak fetch fixtures.json                       # into .windbreak/snapshots
windbreak fetch fixtures.json --into /fast/disk     # somewhere bigger
windbreak fetch fixtures.json --force               # refetch valid snapshots
windbreak fetch fixtures.json --projects mine.json  # remotes for your projects
windbreak fetch fixtures.json --json                # for a harness
```

A fixture names a **project**, not a URL, so the URL comes from a registry — the
shipped map plus anything in `--projects`:

```json
{ "version": 1, "projects": { "myproject": { "repo": "https://github.com/me/myproject.git" } } }
```

An unknown project is refused **by name** rather than guessed at. Deriving
`https://github.com/<project>/<project>.git` would either 404 or resolve to a
**fork**, and a fork's history is not the upstream history: §4.4.1 patch-mines fix
commits and §4.4.3 mines atomicity rules out of that history, so the wrong clone
changes which patterns exist before a single candidate is produced.

**The clone is blobless** (`--filter=blob:none`), and that is load-bearing rather
than an optimisation. Every commit and tree is fetched and only the file contents
are deferred. The obvious `--depth 1` would leave those two miners one commit of
history to work with, and they would find nothing and say so only in their own
coverage counters.

```
$ windbreak fetch fixtures.json --projects mine.json

Materializing 2 snapshot(s) into .windbreak/snapshots
  libarchive@6a7b8c9d0e1f   cloned   12.4s  .windbreak/snapshots/libarchive-6a7b8c9d0e1f2a3b
  myproject@9cdbb82fce38    cached    0.0s  .windbreak/snapshots/myproject-9cdbb82fce38722737006b

Scan one with:
  windbreak scan --target .windbreak/snapshots/libarchive-6a7b8c9d0e1f2a3b

2/2 snapshot(s) materialized
```

A cached checkout is reused only when three things agree: a completion marker
exists, `HEAD` still matches the pinned revision, and the tree is still clean. The
third is the one that matters most, because a scan records the revision it saw *and
asserts a clean tree* — a snapshot edited in place is still pinned to the right
commit and no longer contains its code, which would make the run's provenance wrong
in a way no number in the report could show. Anything that fails a check is
deleted and refetched rather than repaired.

One failure does not stop the others — repositories are independent — but any
failure exits 1, because a partly materialized corpus must not read as a complete
one.

### Tier 1 — a function-level corpus

§11 has two tiers and the same command serves both; the input file declares which
with a `kind`. A **pair set** is vulnerable/patched halves of the same function
(§11.1), and unlike a fixture list it is not scored from the database — it is
*driven*: each half becomes a real candidate and `runTriage` and `runVerification`
run over it unmodified, so the measurement is of the shipping prompts and the
§8.4 verdict cache applies. Copy
[`docs/primevul-pairs.example.json`](./docs/primevul-pairs.example.json).

```bash
windbreak eval pairs.json --db .windbreak/state.db
windbreak eval pairs.json --no-cache        # force fresh calls
```

This tier needs a provider, and it prints what it will spend before it spends it.

The result is a 2×2 per stage, not a funnel, because the ground truth is
two-sided: the vulnerable half is a bug and the patched half is the same function
fixed. `discriminated` is the column that cannot be faked — the share of pairs
where the stage kept the bug **and** cleared the fix:

```
stage                      pairs  tp  fn  fp  tn  sensitivity  false alarm  precision  discriminated  fn/fa
triage (§4.6)                  3   2   1   1   2        0.667        0.333      0.667          0.333  1.00x
verification (§5.2)            3   2   1   0   3        0.667        0.000      1.000          0.667      —
composed (shipping order)      3   1   2   0   3        0.333        0.000      1.000          0.333      —
```

Three rows because one number hides the interaction: the Refuter over-killing a
single kept half leaves verification looking fine on its own while the production
figure drops to 0.333. `fn/fa` is §15's asymmetry — false negatives over false
alarms — which is the number that exposes a stage that suppresses findings rather
than judging them. It is `—` rather than `∞` when there were no false alarms to
compare against.

Two things to hold onto when reading it. A half whose call **failed** is
`unscored` and belongs to neither side, so a provider outage cannot look like a
stage that correctly called everything clean. And this is **not repo-scale
evidence** (§11.1): there is no engine candidate, no call path, and no program
model, so nothing here says the pipeline finds bugs in a repository. There is no
recall gate on this tier — D11's bar is repo-level, and applying it to a
function-level denominator is refused rather than silently done.

## Running it

WindBreak is a workspace in this monorepo, so it shares the repo's Bun setup:

```bash
bun install          # from the repo root
bun run windbreak    # == bun --cwd windbreak dev
```

**Three spellings of the same CLI, and the examples below use the shortest.** `bun run
windbreak` from the repo root and the package's own `windbreak` bin are the CLI itself;
installed out of this checkout through the launcher it is `windbreak-cli` (see *The
launcher* below). Anywhere an example says `windbreak scan`, an installed `windbreak-cli
scan` is the same command — and neither is the screen, which is `windbreak-tui`.

Checks:

```bash
bun run typecheck:windbreak
bun run test:windbreak
```

### One target, without typing `--target` every time

`--target` is still how a target is named, and a command with none still refuses rather
than guessing. What it does not have to be is *repeated*: `<cwd>/.windbreak/config.json`
can carry the default for the checkout you are working in.

```json
{
  "target": {
    "location": "..",
    "db": "state.db"
  }
}
```

A relative path resolves against the **config file's own directory**, not the working
directory, so a configured target means the same checkout no matter which shell the
command came from. Resolving it against the working directory would make the default
depend on where you happened to be — and the failure that prevents is the quiet one: a
scan pointed at a stale sibling directory, reporting numbers about something other than
what you think. The file above is the conventional one,
`<target>/.windbreak/config.json`, so `".."` is the target and `"state.db"` resolves to
`<target>/.windbreak/state.db` beside it — the same path the built-in default already
uses, which is why `db` is only worth setting when state should live elsewhere.

**Discovery is `$WINDBREAK_CONFIG` first, then `<cwd>/.windbreak/config.json`, and that
is a trust decision worth naming.** The file it finds may be sitting inside a checkout
WindBreak is about to scan. Everything in it is read-only to a scan — it selects models,
budgets, extra rule paths and the default target, and it cannot cause code to run — but a
repository that ships its own `.windbreak/config.json` can redirect the default target or
widen the rule set of the tool scanning it. Point `$WINDBREAK_CONFIG` at a file outside
the target when that matters for what you are scanning.

What every command is running with is **one** document — the target default, the models,
the budgets and the extra rule paths all resolve from the same file, so `config show`
cannot report built-ins while a scan runs something else. It prints the file it read, so
"is my config in effect" has an answer rather than an inference:

```bash
windbreak config show      # "source": null means no config was found, not an empty one
```

State in the target's own `.windbreak` is the convention, which is why the repository
that holds it should ignore that directory: recon's dirty check runs `git status`, and an
untracked `.windbreak/` under a scanned checkout makes every scan of it warn that the
tree does not correspond to a committed revision.

### The launcher

`scripts/windbreak-cli` runs the CLI with the target as the working directory, which is
the whole mechanism: run *from* the target and the discovered config, the state database,
scratch space and reports all land in that one folder.

```bash
ln -sf "$PWD/windbreak/scripts/windbreak-cli" ~/.local/bin/windbreak-cli
windbreak-cli scan --static-only --yes
```

A symlink for the same reason as `windbreak-tui`: both launchers run source out of this
checkout, so a link cannot go stale the way a copy can. `install -m 755` still works, and
then `WINDBREAK_ROOT=<checkout>` has to be exported for the script to find one.

Both look for bun in `$BUN`, then `PATH`, then `${BUN_INSTALL:-~/.bun}/bin/bun`. The last
one matters because a terminal that was already open when bun was installed never re-reads
its rc file — "this shell cannot find bun" is a different finding from "bun is not
installed", and only the second one is worth stopping for.

`WINDBREAK_TARGET=/some/other/repo` points it at a different checkout, and an explicit
`--target` or `--db` still wins over both — an option always beats a default. It is a
different entry point from `scripts/windbreak-tui` beside it, which opens the adjudication
screen; this one is the standalone scan surface.

**The two entry points answer "which repository" differently, and it is worth knowing
which one you are in.** The batch surface is the *configured* target: it runs from the
target, so the config, the state database and the reports are all about that checkout no
matter where you typed the command. The screen is *where you are*: it resolves the
repository by walking up to `.git` and reads the database belonging to that checkout, so
opening it in a subdirectory of a scanned project shows that project — and in a checkout
nothing has scanned yet it opens the file pane on that checkout, marked unscanned.
`windbreak-tui` resolves that from the target it runs from, so when `WINDBREAK_TARGET` names
the same checkout the two entry points agree about which repository they are describing.

```bash
ln -sf "$PWD/windbreak/scripts/windbreak-tui" ~/.local/bin/windbreak-tui
windbreak-tui                      # the screen, running this checkout's source
```

### Which database the screen opens

The screen resolves its database from the *repository* it is showing, not from the
directory the command was typed in, in this order:

1. `--db`, when you name one.
2. The `target.db` of that checkout's own config — `--config`, else `$WINDBREAK_CONFIG`,
   else `<checkout>/.windbreak/config.json`.
3. `<checkout>/.windbreak/state.db`, the convention every command writes to.

Two things about that are deliberate and worth knowing.

**A configured `db` outranks the convention, which is what makes `"db": "…"` mean
anything to the screen.** Before this the screen resolved the conventional path only, so a
checkout whose state had been moved opened an *absent* database and drew an empty queue over
a run sitting in the file it had been told to use — an empty queue standing in for an unread
one, which is the substitution §18 exists to prevent.

**`--cwd` now moves the queue along with the repository.** It always moved the file pane —
`--cwd` is what the screen resolves the repository from — while an earlier build resolved
the default database at module load, against the *process* working directory, so the two
disagreed. Resolving both from the same repository root is what closes that; the screen's own
comment already claimed it, "resolved here, once … so the file pane and the models cannot be
looking at two different checkout".

**The chat pane's limits are the one thing still read only from a named `--config`**, and
that asymmetry is on purpose. `target.db` is a path; the rest of the document selects models
and budgets, and the ceiling on model calls is a *spend* limit. Reading it from the checkout —
a directory that may be untrusted — would let a scanned repository raise the ceiling on the
researcher's calls, so naming the file is how you raise it. The scan the screen can start
still reads the discovered config, as every batch command does.

The config is looked for at the **repository root** rather than the working directory, which
is the one place this deliberately differs from `discoverConfigPath`: opened from
`<repo>/src/deep`, the conventional path is a directory the config is not in, and a configured
database would be silently ignored from every subdirectory. `$WINDBREAK_CONFIG` and
`--config` behave exactly as they do elsewhere.

One narrowing to know: the shim used to walk up for any `.windbreak/state.db`, so state
placed above a tree with no `.git` anywhere was found from a subdirectory. The screen now
anchors at the repository it lists, which for such a tree is the directory you are in — the
file pane and the queue agree, but state kept further up is not discovered. Run from the
directory that holds the state, or name it with `--db`.

A `target.location` still means nothing to the screen, which opens on the checkout you are
in. That one is not a gap: silently showing a repository you are not standing in is the
worse of the two surprises, and in the conventional layout the two agree anyway —
`<target>/.windbreak/config.json` is written `".."`, which is the checkout.

## Model routing

Every model call goes through `@codebuff/sdk` in-process, from
`src/client.ts` — one routing point, as the spec requires. The auth token is
resolved exactly as the CLI resolves it (`src/auth.ts`): `credentials.json`
first, then the `CODEBUFF_API_KEY` environment variable, so the same path works
headlessly in CI.

Verification uses two different vendors on purpose: the Proposer runs on
DeepSeek V4.1 Flash and the Refuter on GLM 5.3 Flash. A shared blind spot
cannot pass both gates. `windbreak config validate` refuses a configuration
where both resolve to the same provider. Both models are unmetered at full
access, so a scan does not consume the researcher's daily sessions.

§20.29's investigator has its own row, `models.investigator`, and is deliberately
**not** one of the verification roles. It is configured and recorded like any other
model — but the union the verdict path accepts does not contain it, so no investigator
answer can reach a verdict, the cache, or a disposition. That is a compile-time
property rather than a convention, and it is what §5.3's escalation signal rests on.

The investigator's own limiter is not a model choice but a spend one:
`investigator.maxSteps` caps one turn and `investigator.maxConversationCalls` caps a whole
conversation in model calls. `windbreak review --config <file>` reads the same file the
batch commands do, so the pane's ceiling is configured where everything else is; without
the flag the defaults above apply.

### Running the model stages for real

The SDK validates its client environment **at import time**, and a token alone is
not enough — `auth status` can report OK while every model stage degrades to
"no model invoker is available". That environment is supplied for you; a token is
the only thing a live run needs:

```bash
windbreak scan --target /path/to/repo --db .windbreak/state.db
```

Overriding still works, and is the one case worth being careful about: the
provider URL is resolved per call from `NEXT_PUBLIC_CODEBUFF_APP_URL` (or
`CODEBUFF_APP_URL`), so a *stale localhost value already exported in your shell*
beats the default and sends calls nowhere. Unset it, or set it to the real
backend:

```bash
NEXT_PUBLIC_CODEBUFF_APP_URL=https://www.codebuff.com \
CODEBUFF_APP_URL=https://www.codebuff.com \
  windbreak scan --target /path/to/repo --db .windbreak/state.db
```

Only `CB_ENVIRONMENT`, `CODEBUFF_APP_URL` and the token decide where a call goes;
the Stripe/PostHog values exist to satisfy the import-time validator and are
never contacted. With a token in place, a full live run on a two-function C target
looks like this:

```
[triage] src/copy.c:7 likely-real
[verify] src/copy.c:7 proposer=real refuter=real -> likely-real
  triage        complete  26.4s  2 triaged, 1 likely-real, 1 likely-noise
  verification  complete  35.2s  1 verified: 1 confirmed, 0 dropped, 0 escalated
  reporting     complete   0.0s  1 finding(s)

OK: scan complete.
```

If a model stage reports `left untriaged` / `neither confirmed nor dropped` in its
warnings, that is the honest outcome for a call that failed — the candidate is
kept for a resume rather than counted as clean.

## State schema

The schema is version-gated (`PRAGMA user_version`). A database written by a
different version is refused loudly rather than misread, so after an upgrade
point `--db` at a new file or delete the old one.

The current version is **6**, which added `investigator_turns` for §20.29's
transcript. That table is not `verdicts` and is not read by verification: an
investigator answer is recorded so a researcher can read it, never counted as a
vote.

## Conventions

Follows this repo's rules: Bun for everything, `bun test`, dependency injection
over module mocking, and a `bunfig.toml` preloading the shared env fixture
(see `docs/testing.md`).
