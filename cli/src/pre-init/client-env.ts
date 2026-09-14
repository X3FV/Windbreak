// Fill in the public client environment before anything imports
// `@codebuff/common/env`, which validates `process.env` at import time and
// throws on the first missing `NEXT_PUBLIC_*` value. A source run has no
// `--define`-inlined values the way the compiled binary does, so without this
// the CLI dies on a zod issue dump before `main`.
//
// Must be imported before the `@codebuff/common/*` imports in `index.tsx`:
// those are what reach `common/env`. `package.json` lists `./src/pre-init/*.ts`
// under `sideEffects`, so this bare import survives bundling — the same
// mechanism `tree-sitter-wasm.ts` relies on.
//
// Values come from `@codebuff/common/client-env-defaults`; explicit exports
// still win, and a compiled binary is left untouched.
import { applyClientEnvDefaults } from '@codebuff/common/client-env-defaults'

export const appliedClientEnvDefaults = applyClientEnvDefaults()
