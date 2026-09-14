import type {
  OsvPackageQuery,
  OsvTransport,
  OsvVulnDetail,
  OsvVulnRef,
} from './types'

export const OSV_BASE_URL = 'https://api.osv.dev'
/** OSV accepts up to 1000 queries per batch. */
export const DEFAULT_BATCH_SIZE = 1000
export const DEFAULT_TIMEOUT_MS = 20_000
export const DEFAULT_MAX_RETRIES = 2

export class OsvHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'OsvHttpError'
  }
}

/** Raised when OSV could not be reached or answered unusably. */
export class OsvUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OsvUnavailableError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

/** Copy only the fields the rest of the pipeline reads. */
export const toVulnDetail = (value: unknown): OsvVulnDetail | null => {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  if (!id) return null

  const aliases = Array.isArray(value.aliases)
    ? value.aliases.filter((alias): alias is string => typeof alias === 'string')
    : undefined

  const severity = Array.isArray(value.severity)
    ? value.severity.flatMap((entry) => {
        if (!isRecord(entry)) return []
        const type = asString(entry.type)
        const score = asString(entry.score)
        return type && score ? [{ type, score }] : []
      })
    : undefined

  return {
    id,
    ...(asString(value.summary) ? { summary: asString(value.summary)! } : {}),
    ...(asString(value.details) ? { details: asString(value.details)! } : {}),
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
    ...(asString(value.modified) ? { modified: asString(value.modified)! } : {}),
    ...(asString(value.published)
      ? { published: asString(value.published)! }
      : {}),
    ...(severity && severity.length > 0 ? { severity } : {}),
    ...(isRecord(value.database_specific)
      ? { databaseSpecific: value.database_specific }
      : {}),
  }
}

export interface OsvClientOptions {
  baseUrl?: string
  /** Injected for tests and for offline runs. */
  transport?: OsvTransport
  batchSize?: number
  maxRetries?: number
  timeoutMs?: number
  /** Injected for tests so backoff does not slow the suite. */
  sleep?: (ms: number) => Promise<void>
}

const createFetchTransport = (
  baseUrl: string,
  timeoutMs: number,
): OsvTransport => {
  const request = async (
    method: 'POST' | 'GET',
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      throw new OsvUnavailableError(`Request to ${path} failed`, { cause })
    }

    if (!response.ok) {
      throw new OsvHttpError(
        response.status,
        path,
        `OSV returned ${response.status} for ${path}`,
      )
    }

    try {
      return await response.json()
    } catch (cause) {
      throw new OsvUnavailableError(`OSV returned unparseable JSON for ${path}`, {
        cause,
      })
    }
  }

  return {
    post: (path, body) => request('POST', path, body),
    get: (path) => request('GET', path),
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Thin OSV.dev client.
 *
 * `queryPackageBatch` uses `/v1/querybatch`, which returns only `{id, modified}`
 * per hit — details cost one `/v1/vulns/{id}` per match. Batching first and
 * enriching only matches keeps a clean target to a single request.
 */
export class OsvClient {
  private readonly transport: OsvTransport
  private readonly batchSize: number
  private readonly maxRetries: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: OsvClientOptions = {}) {
    this.transport =
      options.transport ??
      createFetchTransport(
        options.baseUrl ?? OSV_BASE_URL,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.sleep = options.sleep ?? defaultSleep
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error

        const retryable =
          error instanceof OsvUnavailableError ||
          (error instanceof OsvHttpError &&
            (error.status === 429 || error.status >= 500))

        if (!retryable || attempt === this.maxRetries) break
        await this.sleep(500 * 2 ** attempt)
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new OsvUnavailableError(String(lastError))
  }

  /**
   * Query packages in batches.
   *
   * The returned array is positionally aligned with `queries`; a response whose
   * length does not match its batch throws rather than being trusted, because a
   * misalignment would silently attribute a vulnerability to the wrong package.
   */
  async queryPackageBatch(
    queries: readonly OsvPackageQuery[],
  ): Promise<OsvVulnRef[][]> {
    const results: OsvVulnRef[][] = []

    for (let index = 0; index < queries.length; index += this.batchSize) {
      const batch = queries.slice(index, index + this.batchSize)

      const response = await this.withRetry(() =>
        this.transport.post('/v1/querybatch', {
          queries: batch.map((query) => ({
            package: { name: query.name, ecosystem: query.ecosystem },
            version: query.version,
          })),
        }),
      )

      if (!isRecord(response) || !Array.isArray(response.results)) {
        throw new OsvUnavailableError('querybatch response had no results array')
      }

      if (response.results.length !== batch.length) {
        throw new OsvUnavailableError(
          `querybatch returned ${response.results.length} results for ${batch.length} queries; refusing to align them`,
        )
      }

      for (const entry of response.results) {
        const vulns = isRecord(entry) && Array.isArray(entry.vulns) ? entry.vulns : []
        results.push(
          vulns.flatMap((vuln) => {
            if (!isRecord(vuln)) return []
            const id = asString(vuln.id)
            if (!id) return []
            return [{ id, ...(asString(vuln.modified) ? { modified: asString(vuln.modified)! } : {}) }]
          }),
        )
      }
    }

    return results
  }

  /** `/v1/query` with a commit resolves fixes across many ecosystems. */
  async queryCommit(commit: string): Promise<OsvVulnDetail[]> {
    const response = await this.withRetry(() =>
      this.transport.post('/v1/query', { commit }),
    )

    if (!isRecord(response)) {
      throw new OsvUnavailableError('commit query returned a non-object')
    }

    const vulns = Array.isArray(response.vulns) ? response.vulns : []
    return vulns.flatMap((vuln) => {
      const detail = toVulnDetail(vuln)
      return detail ? [detail] : []
    })
  }

  /** Full record for one advisory id. Returns null on 404. */
  async getVuln(id: string): Promise<OsvVulnDetail | null> {
    try {
      const response = await this.withRetry(() =>
        this.transport.get(`/v1/vulns/${encodeURIComponent(id)}`),
      )
      return toVulnDetail(response)
    } catch (error) {
      if (error instanceof OsvHttpError && error.status === 404) return null
      throw error
    }
  }
}
