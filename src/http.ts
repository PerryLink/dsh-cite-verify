/**
 * The bounded HTTP client used for metadata lookups.
 *
 * - HTTPS only, exact-host allowlist, no credentials in the URL, no custom port.
 * - Redirects are followed manually: every hop resolves and re-validates the
 *   target, so an allowlisted host cannot bounce the client to an internal one.
 * - Per-request deadline, per-host minimum interval, bounded retries on 429/503.
 *
 * The `fetch` implementation is injectable, so every test runs without network.
 *
 * @module dsh-cite-verify/http
 */

/** The hosts this plugin is allowed to talk to. */
export const ALLOWED_HOSTS: readonly string[] = [
  'api.crossref.org',
  'api.openalex.org',
  'eutils.ncbi.nlm.nih.gov',
  'export.arxiv.org',
]

/** Stable network failure codes. */
export type NetworkErrorCode =
  | 'blocked_host'
  | 'invalid_url'
  | 'too_many_redirects'
  | 'timeout'
  | 'network_error'
  | 'http_error'

/** A transport-level failure (never a "citation is wrong" verdict). */
export class CiteNetworkError extends Error {
  /** The stable code. */
  readonly code: NetworkErrorCode
  /** The HTTP status, when the failure was an HTTP response. */
  readonly status: number | undefined

  constructor(code: NetworkErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'CiteNetworkError'
    this.code = code
    this.status = status
  }
}

/** One HTTP response. */
export interface HttpResponse {
  readonly status: number
  readonly body: string
  readonly url: string
  readonly contentType: string
}

/** The HTTP surface the providers depend on. */
export interface HttpClient {
  get(url: string, options?: { readonly accept?: string }): Promise<HttpResponse>
}

/** The minimal `fetch` shape this client needs. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Options for {@link createHttpClient}. */
export interface HttpClientOptions {
  readonly fetchImpl?: FetchLike
  readonly timeoutMs: number
  readonly minIntervalMs: number
  readonly retries: number
  readonly maxRedirects: number
  readonly userAgent: string
  /** Allowlist override (tests); defaults to {@link ALLOWED_HOSTS}. */
  readonly allowedHosts?: readonly string[]
  /** Clock/sleep injection for deterministic tests. */
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** Validate a URL against the allowlist. */
export function assertAllowed(url: string, allowedHosts: readonly string[] = ALLOWED_HOSTS): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new CiteNetworkError('invalid_url', `not a valid URL: ${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new CiteNetworkError('invalid_url', `only https is allowed, got ${parsed.protocol}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new CiteNetworkError('invalid_url', 'credentials in the URL are not allowed')
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new CiteNetworkError('invalid_url', `non-default ports are not allowed (${parsed.port})`)
  }
  if (!allowedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new CiteNetworkError('blocked_host', `host ${parsed.hostname} is not on the allowlist`)
  }
  return parsed
}

/** Default sleep. */
const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** True when a response is a redirect. */
function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * Create a bounded HTTP client.
 * @param options - bounds and injection points.
 * @returns the client.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike)
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const allowed = options.allowedHosts ?? ALLOWED_HOSTS
  const lastCall = new Map<string, number>()

  const throttle = async (host: string): Promise<void> => {
    const previous = lastCall.get(host)
    if (previous !== undefined) {
      const wait = previous + options.minIntervalMs - now()
      if (wait > 0) await sleep(wait)
    }
    lastCall.set(host, now())
  }

  const request = async (url: string, accept: string | undefined): Promise<Response> => {
    let attempt = 0
    for (;;) {
      let response: Response
      try {
        response = await fetchImpl(url, {
          redirect: 'manual',
          headers: {
            'user-agent': options.userAgent,
            ...(accept === undefined ? {} : { accept }),
          },
          signal: AbortSignal.timeout(options.timeoutMs),
        })
      } catch (error) {
        const name = (error as Error).name
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new CiteNetworkError('timeout', `request timed out after ${options.timeoutMs} ms: ${url}`)
        }
        throw new CiteNetworkError('network_error', `network error for ${url}: ${(error as Error).message}`)
      }
      if ((response.status === 429 || response.status === 503) && attempt < options.retries) {
        attempt += 1
        const retryAfter = Number(response.headers.get('retry-after') ?? '')
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 500 * attempt)
        continue
      }
      return response
    }
  }

  return {
    async get(url: string, requestOptions: { accept?: string } = {}): Promise<HttpResponse> {
      let current = assertAllowed(url, allowed).toString()
      for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
        const host = new URL(current).hostname.toLowerCase()
        await throttle(host)
        const response = await request(current, requestOptions.accept)
        if (isRedirect(response.status)) {
          const location = response.headers.get('location')
          if (location === null || location === '') {
            throw new CiteNetworkError('network_error', `redirect without a Location header from ${current}`, response.status)
          }
          const next = new URL(location, current)
          current = assertAllowed(next.toString(), allowed).toString()
          continue
        }
        const body = await response.text()
        if (response.status >= 400) {
          return { status: response.status, body, url: current, contentType: response.headers.get('content-type') ?? '' }
        }
        return { status: response.status, body, url: current, contentType: response.headers.get('content-type') ?? '' }
      }
      throw new CiteNetworkError('too_many_redirects', `more than ${options.maxRedirects} redirects starting at ${url}`)
    },
  }
}
