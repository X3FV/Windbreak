import fs from 'fs'
import path from 'path'

import { Database } from 'bun:sqlite'

/**
 * Bump when SCHEMA_SQL changes in a way that existing runs cannot read.
 * Stored in `PRAGMA user_version` so a mismatched database fails loudly rather
 * than being silently misread.
 */
export const SCHEMA_VERSION = 8

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  config_json TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  cache_disabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  location TEXT NOT NULL,
  commit_sha TEXT,
  languages_json TEXT,
  build_model TEXT,
  scope_class TEXT,
  program_model_path TEXT,
  -- 'complete' | 'partial' | 'unavailable'; NULL means correlation never ran.
  -- A failed run must not look like a clean one (spec §18).
  osv_status TEXT,
  created_at TEXT
);

-- Recon: the file inventory the rest of the pipeline reasons over.
CREATE TABLE IF NOT EXISTS recon_files (
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  language TEXT,
  bytes INTEGER NOT NULL,
  binary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (target_id, path)
);

-- Recon: the program model's symbol index.
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  name TEXT NOT NULL,
  qualifier TEXT,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbol_refs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  language TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  pattern_id TEXT,
  origin_patch_sha TEXT,
  file_path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  cwe TEXT,
  normalized_json TEXT NOT NULL,
  injection_signals_json TEXT,
  state TEXT NOT NULL,
  osv_match_json TEXT,
  -- §4.6 triage label: likely-real | likely-noise | needs-context. NULL means
  -- triage never ran. Stored on the candidate (not only on the verdict) so
  -- verification can select its input set with one indexed query.
  triage TEXT
);

CREATE TABLE IF NOT EXISTS verdicts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  role TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  temperature REAL NOT NULL,
  seed INTEGER,
  seed_supported INTEGER NOT NULL,
  cache_key TEXT NOT NULL UNIQUE,
  output_json TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS adjudication_queue (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  proposer_verdict_id TEXT NOT NULL,
  refuter_verdict_id TEXT NOT NULL,
  decision TEXT,
  decided_at TEXT,
  rationale TEXT
);

-- §8.4 verdict cache. §2.1.3 makes determinism a gate, and the cache is what
-- satisfies it: a cache hit replays the recorded output instead of re-asking a
-- provider that cannot be pinned to a seed. verdicts.cache_key points here.
CREATE TABLE IF NOT EXISTS verdict_cache (
  cache_key TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  output_json TEXT NOT NULL,
  created_at TEXT
);

-- §20.29.3: the investigator is recorded as a **distinct role** and never as a
-- proposer or refuter verdict. It gets its own table rather than a row in
-- 'verdicts' because a turn is not the same kind of thing: it is prose from a
-- multi-step tool-using loop, not a structured judgement about one candidate.
-- Hence candidate_id is nullable (a §20.29.4 hunt has no candidate), there is no
-- cache_key (an answer produced after reading files cannot be replayed from a key
-- the way §8.4 replays a verdict), and there is no verdict column at all — an
-- investigator has no opinion the pipeline may count.
--
-- The absence is the enforcement. runVerification reads proposer and refuter
-- verdicts rows; it has no query against this table, and a test asserts its
-- disposition is unmoved by one.
CREATE TABLE IF NOT EXISTS investigator_turns (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- NULL for a hunt; set for "explain this candidate".
  candidate_id TEXT REFERENCES candidates(id) ON DELETE CASCADE,
  -- 'explain' | 'hunt' (§20.29.4's two modes).
  mode TEXT NOT NULL,
  -- Which agent produced the turn (schema v7, §20.30). 'investigator' answers about
  -- the read-only target; 'engineer' edits the working copy. Recorded per turn
  -- because the switch is a property of the question, not of the screen: the same
  -- pane asks both, so "which one said this" is not recoverable from anything else.
  -- Defaults to 'investigator' so a database written before the engineer existed
  -- reads as what it was rather than as an unknown.
  agent TEXT NOT NULL DEFAULT 'investigator',
  -- The working copy this turn ran against (schema v7, §20.30.1), or NULL for a
  -- turn that only read the target. A path alone would not identify it: the copy is
  -- recreated per screen session, so the same path is two different trees at two
  -- different times, and an edit attributed to the wrong one is worse than an
  -- unattributed one. See working_copies below.
  working_copy_id TEXT,
  -- CopyWriteRecord[]: which files this turn wrote, with what action and how many
  -- lines. NULL or empty for a turn that wrote nothing.
  writes_json TEXT,
  -- The researcher's question, verbatim.
  prompt TEXT NOT NULL,
  -- The assistant's prose. NULL only when the turn failed; a failed turn is
  -- recorded rather than dropped, so "no answer" and "never asked" stay apart
  -- (§18).
  answer TEXT,
  error TEXT,
  -- 1 when the answer rests on tool results, which is every successful turn. A
  -- reader can then tell this apart from a verdict produced under the §5.1 fence
  -- (§20.29.3, third consequence).
  tool_derived INTEGER NOT NULL DEFAULT 0,
  -- ToolResultRecord[]: which tools ran, how much text each returned, and which
  -- instruction-like lines were neutralized on the way in.
  tool_calls_json TEXT,
  -- Every signal neutralized across the turn, so an injected-against answer is
  -- reviewable as one rather than as an opinion.
  injection_signals_json TEXT,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TEXT
);

-- §20.30: the writable copy of the target an engineer agent edits. Its own table
-- rather than a column on the run, because a run can have more than one over the
-- life of a screen session — and because a turn has to be able to point at the
-- *copy* it wrote to, not merely at the run.
CREATE TABLE IF NOT EXISTS working_copies (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  -- The copy's own root. Never the target: the target is the evidence and is not
  -- writable, which is what makes a write here attributable to a copy.
  path TEXT NOT NULL,
  -- The revision the target was pinned to when the copy was made, when recon
  -- recorded one. NULL is honest: an unpinned or non-repository target has none.
  base_commit_sha TEXT,
  -- 'filtered-copy' today; §20.30.1 records why a git worktree was rejected.
  strategy TEXT NOT NULL,
  files INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  evidence_tier TEXT NOT NULL,
  sarif_path TEXT,
  writeup_path TEXT,
  created_at TEXT
);

-- Pattern library (spec §10). A checker is stored only once it has been
-- validated against the site it was mined from, and replayed only while it
-- stays 'confirmed' (D15). The source column holds the checker's own text —
-- for the fingerprint pattern form that is the fingerprint JSON, which is data
-- rather than code and therefore cannot execute anything at replay time.
CREATE TABLE IF NOT EXISTS checkers (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  -- The revision the pattern was mined from. Named for §10's origin patch, but
  -- recorded as the origin commit when no fix commit is known (§20.12).
  origin_patch_sha TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT 'unconfirmed',
  source TEXT NOT NULL,
  -- Hits on the pre-image. 0 means the pattern no longer catches the site it
  -- came from, i.e. it has drifted and must be skipped, not tuned.
  pre_image_hits INTEGER,
  -- 1 when the pattern was proven silent on a post-image, NULL when no
  -- post-image was supplied. NULL is honest: that check did not run.
  post_image_clean INTEGER,
  precision_observed REAL,
  -- Provenance: the confirmed finding that seeded the pattern, so a replay hit
  -- can always be traced back to the discovery it generalizes (§10, §4.8).
  finding_id TEXT,
  candidate_id TEXT,
  target_id TEXT,
  cwe TEXT,
  -- The seeding finding's evidence tier. Recorded so a replay refusal can say
  -- which gate failed instead of just "unconfirmed" (§2.1.5).
  evidence_tier TEXT,
  -- The site the pattern must still catch, as { filePath, functionName, line }.
  -- Drift is decided against this, not against a hit count (§20.12.1).
  origin_site_json TEXT,
  -- Who synthesized it, so a bad pattern can be attributed (§8.1's new row).
  model_id TEXT,
  provider TEXT,
  prompt_template_version TEXT,
  retired_at TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS checker_replays (
  id TEXT PRIMARY KEY,
  checker_id TEXT NOT NULL REFERENCES checkers(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  revalidated INTEGER NOT NULL,
  candidates_found INTEGER NOT NULL,
  -- Why a checker produced nothing, so a skipped checker is never mistaken for
  -- a clean one (§18). NULL when the replay actually ran.
  skipped_reason TEXT,
  -- Commit the replayed target was pinned to, for §11.3's across-run compare.
  target_commit_sha TEXT,
  ran_at TEXT
);

CREATE TABLE IF NOT EXISTS budget_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  quota_seconds INTEGER NOT NULL,
  elapsed_seconds INTEGER NOT NULL,
  action TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS run_metrics (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  stage_json TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  cache_hit_rate REAL,
  models_json TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  finding_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  channel TEXT,
  notes TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_candidates_state ON candidates(state);
CREATE INDEX IF NOT EXISTS idx_candidates_triage ON candidates(triage);
CREATE INDEX IF NOT EXISTS idx_verdicts_candidate ON verdicts(candidate_id);
CREATE INDEX IF NOT EXISTS idx_checkers_pattern ON checkers(pattern_id);
CREATE INDEX IF NOT EXISTS idx_investigator_turns_run ON investigator_turns(run_id);
CREATE INDEX IF NOT EXISTS idx_investigator_turns_candidate ON investigator_turns(candidate_id);
CREATE INDEX IF NOT EXISTS idx_investigator_turns_agent ON investigator_turns(run_id, agent);
CREATE INDEX IF NOT EXISTS idx_working_copies_run ON working_copies(run_id);
-- Known-vulnerability correlation (spec §4.2).
CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  exact INTEGER NOT NULL DEFAULT 0,
  queryable INTEGER NOT NULL DEFAULT 0,
  manifest_path TEXT NOT NULL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS osv_matches (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  source TEXT NOT NULL,              -- 'package' | 'commit'
  dependency_id TEXT,
  ecosystem TEXT,
  name TEXT,
  version TEXT,
  commit_sha TEXT,
  vuln_id TEXT NOT NULL,
  summary TEXT,
  published TEXT,
  modified TEXT,
  aliases_json TEXT,
  severity_json TEXT,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recon_files_target ON recon_files(target_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_target ON dependencies(target_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_target_name ON dependencies(target_id, name);
CREATE INDEX IF NOT EXISTS idx_osv_matches_target ON osv_matches(target_id);
CREATE INDEX IF NOT EXISTS idx_osv_matches_vuln ON osv_matches(target_id, vuln_id);
CREATE INDEX IF NOT EXISTS idx_symbols_target_name ON symbols(target_id, name);
CREATE INDEX IF NOT EXISTS idx_symbols_target_file ON symbols(target_id, file_path);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_target_name ON symbol_refs(target_id, name);

-- Automated dynamic confirmation (spec §20.35). One row per candidate per run.
--
-- Every attempt is recorded, not only the ones that worked out. A table holding
-- just the successes could not answer the question a reader actually has — how
-- often this stage was *unable* to run — and a build failure is a fact about
-- the machine, not about the finding, so losing it would make a broken host
-- look like clean code.
CREATE TABLE IF NOT EXISTS confirmations (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  -- 'confirmed' | 'unattributed' | 'not-reproduced' | 'ineligible'
  -- | 'build-failed' | 'run-failed'
  outcome TEXT NOT NULL,
  -- Why, in the case's own terms. Never null: an outcome without a reason is
  -- exactly what this stage exists to avoid stating.
  detail TEXT NOT NULL,
  -- The sanitizer's category, when one fired.
  signature TEXT,
  -- JSON {filePath, line}, when the report landed in the finding's own code.
  location TEXT,
  fuzz_seconds INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_confirmations_candidate ON confirmations(candidate_id);
CREATE INDEX IF NOT EXISTS idx_confirmations_run ON confirmations(run_id);
`

export class SchemaVersionMismatchError extends Error {
  constructor(found: number) {
    super(
      `State database schema version ${found} does not match the expected ${SCHEMA_VERSION}. ` +
        `Point --db at a different file or delete it to start clean.`,
    )
    this.name = 'SchemaVersionMismatchError'
  }
}

/**
 * Open (creating if needed) the run-state database and ensure the schema.
 *
 * `:memory:` is accepted so tests and `db init --path :memory:` need no disk.
 */
export const openStateDatabase = (databasePath: string): Database => {
  // A nested path like `.windbreak/state.db` must not require the caller to
  // have created the directory first; SQLite reports a bare CANTOPEN otherwise.
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true })
  }

  const db = new Database(databasePath, { create: true })

  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')

  const version = db.query<{ user_version: number }, []>(
    'PRAGMA user_version',
  ).get()?.user_version

  if (version && version !== SCHEMA_VERSION) {
    db.close()
    throw new SchemaVersionMismatchError(version)
  }

  applySchema(db)
  return db
}

export const applySchema = (db: Database): void => {
  db.exec(SCHEMA_SQL)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
}

/** Table names present in the database, for verification and diagnostics. */
export const listTables = (db: Database): string[] =>
  db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((row) => row.name)
