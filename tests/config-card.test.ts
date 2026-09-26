/**
 * Browser half: the OmniRoute card on the Plugins page.
 *
 * The file is evaluated the way the client module system evaluates it — a
 * lazy-CJS factory registered on `window.__ModuleLoader__` — over a minimal
 * React (element trees plus two hooks) and a fake browser plugin context, so
 * the form's validation and its settings operations are checked without a DOM.
 *
 * @module dsh-omniroute/tests/config-card
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

/* eslint-disable @typescript-eslint/no-explicit-any -- a hand-built element tree has no React types. */
type Element = { type: any; props: Record<string, any> & { children?: any } }
type Tree = any

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

/** The element tree plus the hooks a component reaches for. */
function createReact(): { hooks: { cells: any[]; index: number }; createElement: any; useState: any; useSyncExternalStore: any } {
  const hooks = { cells: [] as any[], index: 0 }
  return {
    hooks,
    createElement(type: any, props: any, ...children: any[]): Element {
      return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
    },
    useState(initial: any): [any, (next: any) => void] {
      const cell = hooks.index++
      if (!Object.hasOwn(hooks.cells, cell)) {
        hooks.cells[cell] = typeof initial === 'function' ? initial() : initial
      }
      return [
        hooks.cells[cell],
        (next: any) => { hooks.cells[cell] = typeof next === 'function' ? next(hooks.cells[cell]) : next },
      ]
    },
    useSyncExternalStore(_subscribe: any, getSnapshot: any): any { return getSnapshot() },
  }
}

/** Load `lib/client.js` through the module loader and return its exports. */
function loadClient(): { registration: any; exports: any; React: ReturnType<typeof createReact> } {
  let registration: any
  const window = { __ModuleLoader__: { load: (spec: any) => { registration = spec } } }
  // The file is a script, not a module: it registers itself, exactly as the
  // module system evaluates it in the page.
  new Function('window', SOURCE)(window)
  const React = createReact()
  const exports = registration.factory((id: string) => {
    assert.equal(id, 'react')
    return React
  })
  return { registration, exports, React }
}

/** Render a component function with its own hook frame. */
function mountComponent(component: any, props: any, React: ReturnType<typeof createReact>): Tree {
  React.hooks.index = 0
  return renderNode(component(props), React)
}

/** Render one element tree, running function components. */
function renderNode(node: any, React: ReturnType<typeof createReact>): Tree {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child: any) => renderNode(child, React))
  if (typeof node.type === 'function') {
    const saved = React.hooks.index
    React.hooks.index = 0
    const rendered = node.type(node.props)
    React.hooks.index = saved
    return renderNode(rendered, React)
  }
  return { type: node.type, props: { ...node.props, children: renderNode(node.props.children ?? [], React) } }
}

/** Every element of one type in a rendered tree, depth first. */
function findAll(node: any, type: string): Element[] {
  const found: Element[] = []
  const visit = (current: any): void => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (current.type === type) found.push(current)
    visit(current.props?.children ?? [])
  }
  visit(node)
  return found
}

/** The concatenated text of a rendered subtree. */
function textOf(node: any): string {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children ?? [])
}

/** One fake browser context with its recorded surface and a mutable scope. */
function createClient(options: { status?: string, writable?: boolean, acceptWrites?: boolean, value?: Record<string, unknown>, user?: Record<string, unknown> } = {}): any {
  const { exports, React } = loadClient()
  const record: any = { mutations: [], ops: [] }
  const snapshot = {
    status: options.status ?? 'ready',
    value: options.value ?? {
      baseURL: 'http://localhost:20128', apiKeyEnv: 'OMNIROUTE_API_KEY', timeoutMs: 10_000,
      cacheSeconds: 30, syncNamespace: 'llm-pi-ai', syncProvider: 'omniroute',
    },
    base: {},
    user: options.user ?? {},
    revision: 1,
    writable: options.writable !== false,
    mode: 'host',
  }
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async (ops: any[]) => {
      record.mutations.push(ops)
      return options.acceptWrites !== false
    },
  }
  const ctx = {
    locale: {
      bind: (ns: string) => {
        record.namespace = ns
        return (key: string, params: Record<string, unknown> = {}) => {
          const names = Object.keys(params)
          return names.length === 0 ? key : `${key}:${names.map((name) => String(params[name])).join(',')}`
        }
      },
      register: (ns: string, dictionaries: unknown) => { record.locale = { ns, dictionaries } },
    },
    effect: (callback: () => unknown, label: string) => { record.effects = [...(record.effects ?? []), label]; return callback() },
    configForms: { get: (ns: string) => { record.configNs = ns; return scope } },
    slots: {
      inject: (name: string, callback: () => void) => { record.injected = name; callback() },
      register: (spec: any, component: any) => { record.slot = spec; record.component = component },
    },
  }
  record.exports = exports
  record.apply = () => exports.apply(ctx)
  record.render = (props: any) => mountComponent(record.component, props, React)
  record.flush = () => new Promise((resolve) => { setImmediate(resolve) })
  record.inputs = (tree: any) => findAll(tree, 'input')
  return record
}

/** Fill one input of the rendered card by its aria label and return the tree. */
function setField(client: any, label: string, value: string): any {
  const tree = client.render({ view: 'page' })
  const input = client.inputs(tree).find((candidate: Element) => candidate.props['aria-label'] === label)
  assert.notEqual(input, undefined, `input "${label}" must render`)
  input.props.onChange({ target: { value } })
  return client.render({ view: 'page' })
}

test('apply binds the namespace and registers the row card', () => {
  const client = createClient()
  client.apply()

  assert.deepEqual(client.exports.inject, ['slots', 'configForms', 'locale'])
  assert.equal(client.configNs, 'omniroute')
  assert.equal(client.namespace, 'omniroute')
  assert.equal(client.locale.ns, 'omniroute')
  assert.equal(typeof client.locale.dictionaries.en.labelBaseURL, 'string')
  assert.equal(typeof client.locale.dictionaries.zh.labelBaseURL, 'string')
  assert.equal(client.injected, 'plugins.row.config')
  assert.equal(client.slot.key, 'dsh-omniroute#omniroute')
  assert.equal(client.slot.locale, 'omniroute')
})

test('an unserved namespace renders nothing at all', () => {
  const client = createClient({ status: 'unavailable' })
  client.apply()
  assert.equal(client.render({ view: 'page' }), null)
  assert.equal(client.render({ view: 'summary' }), null)
})

test('the summary view names the configured host', () => {
  const client = createClient()
  client.apply()
  assert.equal(client.render({ view: 'summary' }), 'summary:http://localhost:20128')
})

test('the page renders every editable field with its stored value', () => {
  const client = createClient()
  client.apply()
  const tree = client.render({ view: 'page' })

  assert.deepEqual(
    client.inputs(tree).map((input: Element) => input.props['aria-label']),
    ['labelBaseURL', 'labelApiKeyEnv', 'labelTimeoutMs', 'labelCacheSeconds', 'labelSyncNamespace', 'labelSyncProvider'],
  )
  assert.deepEqual(
    client.inputs(tree).map((input: Element) => input.props.value),
    ['http://localhost:20128', 'OMNIROUTE_API_KEY', '10000', '30', 'llm-pi-ai', 'omniroute'],
  )
  assert.match(textOf(tree), /persists/)
})

test('a save writes only the fields that moved, as one mutation', async () => {
  const client = createClient()
  client.apply()

  setField(client, 'labelCacheSeconds', '120')
  setField(client, 'labelSyncProvider', 'omniroute-local')
  const tree = client.render({ view: 'page' })
  findAll(tree, 'button').find((button) => textOf(button) === 'save')?.props.onClick()
  await client.flush()

  assert.deepEqual(client.mutations, [[
    { op: 'set', path: ['cacheSeconds'], value: 120 },
    { op: 'set', path: ['syncProvider'], value: 'omniroute-local' },
  ]])
})

test('a read-only deployment disables the controls and says so', async () => {
  const client = createClient({ writable: false })
  client.apply()
  const tree = client.render({ view: 'page' })
  assert.match(textOf(tree), /readOnly/)
  assert.equal(client.inputs(tree).every((input: Element) => input.props.disabled === true), true)
  assert.equal(findAll(tree, 'button').every((button) => button.props.disabled === true), true)
  await client.flush()
  assert.deepEqual(client.mutations, [])
})

test('a save the Host refuses is reported as refused', async () => {
  const client = createClient({ acceptWrites: false })
  client.apply()
  const tree = setField(client, 'labelCacheSeconds', '120')
  findAll(tree, 'button').find((button) => textOf(button) === 'save')?.props.onClick()
  await client.flush()
  assert.match(textOf(client.render({ view: 'page' })), /rejected/)
  assert.equal(client.mutations.length, 1)
})

test('the card refuses a value the host would reject', async () => {
  const client = createClient()
  client.apply()

  let tree = setField(client, 'labelBaseURL', 'localhost:20128')
  findAll(tree, 'button').find((button) => textOf(button) === 'save')?.props.onClick()
  await client.flush()
  assert.match(textOf(client.render({ view: 'page' })), /baseUrlInvalid/)

  tree = setField(client, 'labelBaseURL', 'http://localhost:20128')
  tree = setField(client, 'labelApiKeyEnv', '   ')
  findAll(tree, 'button').find((button) => textOf(button) === 'save')?.props.onClick()
  await client.flush()
  assert.match(textOf(client.render({ view: 'page' })), /textInvalid/)

  tree = setField(client, 'labelApiKeyEnv', 'OMNIROUTE_API_KEY')
  tree = setField(client, 'labelTimeoutMs', '0')
  findAll(tree, 'button').find((button) => textOf(button) === 'save')?.props.onClick()
  await client.flush()
  assert.match(textOf(client.render({ view: 'page' })), /numberInvalid/)

  assert.deepEqual(client.mutations, [])
})

test('an overridden row offers a reset that clears exactly the user layer', async () => {
  const client = createClient({ user: { cacheSeconds: 120 } })
  client.apply()
  const tree = client.render({ view: 'page' })

  const reset = findAll(tree, 'button').find((button) => textOf(button) === 'reset')
  assert.notEqual(reset, undefined)
  reset?.props.onClick()
  await client.flush()
  assert.deepEqual(client.mutations, [[{ op: 'unset', path: ['cacheSeconds'] }]])
})

test('the card version stays in lockstep with package.json', () => {
  assert.match(SOURCE, new RegExp(`const VERSION = '${PACKAGE.version.replace(/\./gu, '\\.')}'`))
})
