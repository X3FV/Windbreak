// Fill in the public client environment before anything imports
// `@codebuff/common/env`, which validates `process.env` at import time and
// throws on the first missing `NEXT_PUBLIC_*` value. `windbreak` is never
// compiled with those values inlined, so without this every model-using
// command (`scan`, `pipeline`, `eval`, `library add`) requires the operator to
// export the whole set by hand.
//
// Kept as the first import in `index.ts` so it runs before the command modules;
// today none of them reach `common/env` at load, and this is what keeps that an
// accident rather than a requirement.
//
// Values come from `@codebuff/common/client-env-defaults`; explicit exports
// still win.
import { applyClientEnvDefaults } from '@codebuff/common/client-env-defaults'

export const appliedClientEnvDefaults = applyClientEnvDefaults()
