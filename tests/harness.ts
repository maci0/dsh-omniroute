/**
 * Shared fixture for the host-half specs: one fake Cordis context, one request
 * driver, the fetch stub every route case answers with, and the route lookup.
 * `plugin.test.ts` drives the routes through it, `perf.test.ts` counts work
 * through the same mount, and `omniroute.test.ts` stubs its transport with it.
 */

import assert from 'node:assert/strict'
import { apply, ROUTE_CONNECTIONS, ROUTE_MODELS, ROUTE_QUOTA } from '../src/index.ts'
import type { Disposable, HostContext, WebRouteLike } from '../src/host.ts'

/** One captured response. */
export interface Captured {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** Services a case may mount; absent keys read as "not mounted". */
export interface Services {
  settings?: { update(ns: string, patch: object): Promise<void> }
  credentials?: { resolve(ref: string): Promise<{ value: string } | undefined> }
  connection?: { requestRejection(request: { headers: object | undefined }): 401 | 403 | undefined }
}

/** Mount the plugin over a fake context and return its routes by path. */
export function mount(services: Services, config?: Record<string, unknown>): Map<string, WebRouteLike> {
  const routes = new Map<string, WebRouteLike>()
  const ctx = {
    effect: (callback: () => Disposable | void): void => { callback() },
    get: (name: string): unknown => (services as Record<string, unknown>)[name],
    logger: { warn: (): void => {}, error: (): void => {} },
    webServer: {
      register: (route: WebRouteLike): Disposable => {
        routes.set(route.path, route)
        return () => {}
      },
    },
  } as unknown as HostContext
  apply(ctx, config ?? {})
  assert.deepEqual([...routes.keys()].sort(), [ROUTE_CONNECTIONS, ROUTE_MODELS, ROUTE_QUOTA].sort())
  return routes
}

/** Run one request through a route. */
export async function request(route: WebRouteLike, url: string, method = 'GET', headers: object = {}): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: undefined }
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string): void { captured.headers[name] = value },
    end(body?: string): void {
      captured.status = res.statusCode
      captured.body = body === undefined ? undefined : JSON.parse(body)
    },
  }
  await route.handler({ method, url, headers }, res)
  return captured
}

/** Look one route up, insisting it mounted. */
export function routeOf(routes: Map<string, WebRouteLike>, path: string): WebRouteLike {
  const route = routes.get(path)
  assert.ok(route, `${path} did not mount`)
  return route
}

/** One stubbed answer per pathname; a path this map lacks answers 404. */
export function stubFetch(bodies: Record<string, unknown>, calls: string[] = []): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL) => {
    const target = String(url)
    calls.push(target)
    const body = bodies[new URL(target).pathname]
    return Promise.resolve({
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: () => Promise.resolve(body ?? {}),
    })
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}
