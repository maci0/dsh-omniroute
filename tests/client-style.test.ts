/**
 * Browser half: the stylesheet lifecycle. `apply` installs one tagged
 * `<style>` through `ctx.effect`, and running that effect's disposer, as a
 * plugin dispose does, removes it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const packageName = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }).name

/** The registration the bundle hands `window.__ModuleLoader__.load`. */
interface Registration {
  factory: (require: (id: string) => unknown) => Record<string, unknown>
}

let registration: Registration | undefined
;(globalThis as { window?: unknown }).window = {
  __ModuleLoader__: { load: (entry: Registration): void => { registration = entry } },
}
// The bundle registers itself only when evaluated, and the test files share
// one module cache, so the query gives this file its own evaluation.
const bundleSpecifier: string = '../lib/client.js?style'
await import(bundleSpecifier)

/** The slice of a DOM element the stylesheet effect touches. */
interface FakeElement {
  tagName: string
  textContent: string
  setAttribute: (name: string, value: string) => void
  getAttribute: (name: string) => string | null
  remove: () => void
}

/** A `document` with just the head a stylesheet is appended to. */
function createDocument() {
  const head = { children: [] as FakeElement[], append: (node: FakeElement): void => { head.children.push(node) } }
  return {
    head,
    createElement: (tagName: string): FakeElement => {
      const attributes = new Map<string, string>()
      const node: FakeElement = {
        tagName: tagName.toUpperCase(),
        textContent: '',
        setAttribute: (name, value) => { attributes.set(name, value) },
        getAttribute: (name) => attributes.get(name) ?? null,
        remove: () => { head.children = head.children.filter((child) => child !== node) },
      }
      return node
    },
  }
}

test('apply installs one tagged stylesheet and dispose removes it', () => {
  assert.ok(registration, 'the bundle registered itself on window.__ModuleLoader__')
  const exported = registration.factory(() => ({}))
  const disposers: (() => void)[] = []
  const ctx = {
    configForms: { get: () => ({}) },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    effect: (callback: () => unknown): void => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    },
    slots: { inject: (): void => {} },
  }
  const document = createDocument()
  const styles = (): FakeElement[] => document.head.children.filter((node) =>
    node.tagName === 'STYLE' && node.getAttribute('data-plugin') === packageName)

  ;(globalThis as { document?: unknown }).document = document
  try {
    ;(exported['apply'] as (ctx: unknown) => void)(ctx)
  } finally {
    delete (globalThis as { document?: unknown }).document
  }

  assert.equal(styles().length, 1)
  assert.match(styles()[0]?.textContent ?? '', /\.or-/u)
  for (const dispose of disposers.splice(0).reverse()) dispose()
  assert.equal(styles().length, 0)
})
