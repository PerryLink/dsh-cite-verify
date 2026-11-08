/**
 * The bounded HTTP client: allowlist, redirect re-validation, timeout mapping
 * and retry behaviour. Everything runs against an injected `fetch`.
 * @module test/http.spec
 */

import { describe, expect, it } from 'vitest'
import { assertAllowed, CiteNetworkError, createHttpClient } from '../src/http.ts'

/** A fetch double that answers a queue of responses and records URLs. */
function fetchQueue(responses: Array<{ status: number; body?: string; location?: string }>) {
  const calls: string[] = []
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url)
    const next = responses.shift() ?? { status: 200, body: 'done' }
    return new Response(next.body ?? '', {
      status: next.status,
      headers: next.location === undefined ? {} : { location: next.location },
    })
  }
  return { fetchImpl, calls }
}

/** Build a client over the given fetch double. */
function client(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return createHttpClient({
    fetchImpl,
    timeoutMs: 1000,
    minIntervalMs: 0,
    retries: 1,
    maxRedirects: 2,
    userAgent: 'test-agent',
  })
}

describe('allowlist', () => {
  it('accepts an allowlisted https URL', () => {
    expect(assertAllowed('https://api.crossref.org/works/10.1%2Fx').hostname).toBe('api.crossref.org')
  })

  it('rejects http, credentials, custom ports and unknown hosts', () => {
    expect(() => assertAllowed('http://api.crossref.org/works')).toThrow(/only https/u)
    expect(() => assertAllowed('https://user:pass@api.crossref.org/works')).toThrow(/credentials/u)
    expect(() => assertAllowed('https://api.crossref.org:8443/works')).toThrow(/ports/u)
    expect(() => assertAllowed('https://169.254.169.254/latest/meta-data')).toThrow(CiteNetworkError)
    expect(() => assertAllowed('https://localhost/')).toThrow(/allowlist/u)
  })
})

describe('requests', () => {
  it('returns the body of a 200 response', async () => {
    const { fetchImpl, calls } = fetchQueue([{ status: 200, body: '{"ok":true}' }])
    const response = await client(fetchImpl).get('https://api.crossref.org/works/10.1/x')
    expect(response.status).toBe(200)
    expect(response.body).toBe('{"ok":true}')
    expect(calls).toEqual(['https://api.crossref.org/works/10.1/x'])
  })

  it('follows an allowlisted redirect and re-validates the hop', async () => {
    const { fetchImpl, calls } = fetchQueue([
      { status: 302, location: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed' },
      { status: 200, body: 'ok' },
    ])
    const response = await client(fetchImpl).get('https://api.crossref.org/works/10.1/x')
    expect(response.body).toBe('ok')
    expect(calls).toHaveLength(2)
  })

  it('refuses a redirect to a non-allowlisted host', async () => {
    const { fetchImpl } = fetchQueue([{ status: 302, location: 'https://127.0.0.1/internal' }])
    await expect(client(fetchImpl).get('https://api.crossref.org/works/10.1/x')).rejects.toMatchObject({ code: 'blocked_host' })
  })

  it('fails after the redirect budget is spent', async () => {
    const { fetchImpl } = fetchQueue([
      { status: 302, location: 'https://api.crossref.org/a' },
      { status: 302, location: 'https://api.crossref.org/b' },
      { status: 302, location: 'https://api.crossref.org/c' },
    ])
    await expect(client(fetchImpl).get('https://api.crossref.org/start')).rejects.toMatchObject({ code: 'too_many_redirects' })
  })

  it('retries once on 503 and then succeeds', async () => {
    const { fetchImpl, calls } = fetchQueue([{ status: 503 }, { status: 200, body: 'ok' }])
    const response = await client(fetchImpl).get('https://api.crossref.org/works/10.1/x')
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  it('maps a fetch rejection to a network error', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new TypeError('fetch failed')
    }
    await expect(client(fetchImpl).get('https://api.crossref.org/x')).rejects.toMatchObject({ code: 'network_error' })
  })

  it('maps a timeout to a timeout error', async () => {
    const fetchImpl = async (): Promise<Response> => {
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    }
    await expect(client(fetchImpl).get('https://api.crossref.org/x')).rejects.toMatchObject({ code: 'timeout' })
  })
})
