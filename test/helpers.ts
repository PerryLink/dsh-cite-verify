/**
 * Test helpers: fixture loading and a scripted HTTP client (no network in CI).
 * @module test/helpers
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HttpClient, HttpResponse } from '../src/http.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Read one fixture file.
 * @param name - file name under `test/fixtures`.
 * @returns the file contents.
 */
export async function fixture(name: string): Promise<string> {
  return readFile(path.join(here, 'fixtures', name), 'utf8')
}

/** One scripted route. */
export interface Route {
  /** Substring matched against the request URL. */
  readonly match: string
  /** Response status (default 200). */
  readonly status?: number
  /** Response body. */
  readonly body: string
  /** Response content type. */
  readonly contentType?: string
}

/** A scripted client plus its request log. */
export interface ScriptedClient {
  readonly client: HttpClient
  readonly calls: string[]
}

/**
 * Build a client that answers from a route table and logs every URL.
 * @param routes - the routes in match order.
 * @param options - `fail` throws instead of answering.
 * @returns the client and its call log.
 */
export function scriptedClient(routes: readonly Route[], options: { fail?: Error } = {}): ScriptedClient {
  const calls: string[] = []
  const client: HttpClient = {
    async get(url: string): Promise<HttpResponse> {
      calls.push(url)
      if (options.fail !== undefined) throw options.fail
      const route = routes.find(candidate => url.includes(candidate.match))
      if (route === undefined) return { status: 404, body: '', url, contentType: 'text/plain' }
      return {
        status: route.status ?? 200,
        body: route.body,
        url,
        contentType: route.contentType ?? 'application/json',
      }
    },
  }
  return { client, calls }
}
