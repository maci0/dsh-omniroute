/**
 * dsh-omniroute — browser half: the OmniRoute card on the Plugins page.
 *
 * One surface: the OmniRoute card on the Plugins page, keyed on the
 * `omniroute` settings namespace the host half declares as its row id. Every
 * field of the row is volatile, and the host reads it per request, so a save
 * lands on the next poll without remounting the plugin or restarting the
 * server.
 *
 * The form stages edits locally and writes them in one `scope.mutate` call:
 * a half-typed base URL must not reach the settings document field by field.
 * Chrome is a stylesheet, not inline style objects — the module system claims
 * every `<style>` tag a factory appends while it materializes and removes it
 * when the package unloads. Classes are `cj-`-prefixed because that sheet
 * lands in the page's own document.
 *
 * This file is plain JavaScript on purpose. The client module system serves a
 * package's `exports["./client"]` artifact as a lazy-CJS factory registered on
 * `window.__ModuleLoader__`, and that is the whole format — an out-of-tree
 * plugin can author it directly instead of reproducing the repository's tsdown
 * client preset. `react` is provided by the module system; nothing else is
 * required here.
 */

window.__ModuleLoader__.load({
  id: 'dsh-omniroute',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Settings namespace shared with the host half; also this card's slot key. */
    const NAMESPACE = 'omniroute'

    /** Locale namespace for this plugin's copy. */
    const LOCALE_NS = 'omniroute'

    /**
     * Every editable row field, in display order. `integer` fields are sent as
     * numbers and must be positive integers; the host schema bounds each one,
     * and the card refuses what it can see before the write.
     */
    const FIELDS = [
      { key: 'baseURL', kind: 'url', label: 'labelBaseURL', hint: 'hintBaseURL' },
      { key: 'apiKeyEnv', kind: 'text', label: 'labelApiKeyEnv', hint: 'hintApiKeyEnv' },
      { key: 'timeoutMs', kind: 'integer', min: 1, max: 60_000, label: 'labelTimeoutMs', hint: 'hintTimeoutMs' },
      { key: 'cacheSeconds', kind: 'integer', min: 0, max: 3_600, label: 'labelCacheSeconds', hint: 'hintCacheSeconds' },
      { key: 'syncNamespace', kind: 'text', label: 'labelSyncNamespace', hint: 'hintSyncNamespace' },
      { key: 'syncProvider', kind: 'text', label: 'labelSyncProvider', hint: 'hintSyncProvider' },
    ]

    /** Every class is `cj-`-prefixed: the sheet lands in the page's own document. */
    const CSS = [
      '.or-page{display:flex;flex-direction:column;gap:12px}',
      '.or-field{display:flex;flex-direction:column;gap:4px}',
      '.or-label{font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.or-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.or-input{font:inherit;font-size:13px;line-height:1.5;padding:5px 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;width:100%;box-sizing:border-box}',
      '.or-input:disabled{cursor:default;opacity:.5}',
      '.or-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.or-button{appearance:none;font:inherit;font-size:13px;line-height:1.5;padding:5px 14px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.or-button:disabled{cursor:default;opacity:.5}',
      '.or-button-quiet{padding:3px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.or-status{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.or-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
    ].join('')

    // Appended while the factory materializes: the module system claims the tag
    // for this package and disposes it on unload. Guarded because the node unit
    // tests evaluate this file without a DOM.
    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.append(style)
    }

    /** Plugin version, shown in the card footer. Kept in lockstep with package.json. */
    const VERSION = '0.4.3'

    const en = {
      title: 'OmniRoute',
      summary: 'OmniRoute catalog, connections, and quota — {baseURL}',
      summaryEmpty: 'OmniRoute catalog, connections, and quota.',
      labelBaseURL: 'Base URL',
      labelApiKeyEnv: 'API key reference',
      labelTimeoutMs: 'Request deadline (ms)',
      labelCacheSeconds: 'Cache seconds',
      labelSyncNamespace: 'Sync namespace',
      labelSyncProvider: 'Sync provider',
      hintBaseURL: 'OmniRoute origin, with or without its /v1 path.',
      hintApiKeyEnv: 'Credential reference holding the API key; the key itself never reaches the browser.',
      hintTimeoutMs: 'Per-request deadline for one OmniRoute call.',
      hintCacheSeconds: 'How long a reading is served before OmniRoute is asked again. 0 asks every time.',
      hintSyncNamespace: 'Profile entry id ?sync=1 writes the model catalog into.',
      hintSyncProvider: 'Provider route ?sync=1 writes the model catalog into.',
      overridden: 'overridden',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The next poll uses these values.',
      reset: 'Reset to defaults',
      persists: 'Stored in your profile; every route reads the row on each request.',
      readOnly: 'Read-only: this deployment does not persist settings.',
      baseUrlInvalid: 'Base URL must be an absolute http(s) URL.',
      textInvalid: 'Must not be empty.',
      numberInvalid: 'Must be a whole number within the allowed range.',
      rejected: 'The Host refused the write; the previous values are still in effect.',
      failed: 'Could not save: {message}',
      version: 'v{version}',
    }

    const zh = {
      title: 'OmniRoute',
      summary: 'OmniRoute 目录、连接与额度 — {baseURL}',
      summaryEmpty: 'OmniRoute 目录、连接与额度。',
      labelBaseURL: '基础地址',
      labelApiKeyEnv: 'API 密钥引用',
      labelTimeoutMs: '请求超时（毫秒）',
      labelCacheSeconds: '缓存秒数',
      labelSyncNamespace: '同步命名空间',
      labelSyncProvider: '同步提供方',
      hintBaseURL: 'OmniRoute 地址，可带或不带 /v1 路径。',
      hintApiKeyEnv: '保存 API 密钥的凭据引用；密钥本身不会进入浏览器。',
      hintTimeoutMs: '单次 OmniRoute 调用的超时时间。',
      hintCacheSeconds: '一次读取在再次询问 OmniRoute 前可复用的时长。0 表示每次都询问。',
      hintSyncNamespace: '?sync=1 写入模型目录的配置条目 id。',
      hintSyncProvider: '?sync=1 写入模型目录的提供方路由。',
      overridden: '已覆盖',
      save: '保存',
      saving: '保存中…',
      saved: '已保存。下一次轮询将使用这些值。',
      reset: '恢复默认',
      persists: '保存在你的配置中；每个路由都会在每次请求时读取该行。',
      readOnly: '只读：此部署不持久化设置。',
      baseUrlInvalid: '基础地址必须是绝对的 http(s) URL。',
      textInvalid: '不能为空。',
      numberInvalid: '必须是允许范围内的整数。',
      rejected: 'Host 拒绝了写入；原先的值仍然有效。',
      failed: '保存失败：{message}',
      version: 'v{version}',
    }

    /**
     * Bind one settings scope to a React subscription.
     * @param scope - the scope bound to the omniroute settings namespace.
     * @returns a hook reading that scope's current snapshot.
     */
    function useScope(scope) {
      const subscribe = (listener) => scope.subscribe(listener)
      const getSnapshot = () => scope.getSnapshot()
      return () => React.useSyncExternalStore(subscribe, getSnapshot)
    }

    /**
     * Read a snapshot's resolved row. A namespace this deployment does not
     * serve reports no row, which the card renders as nothing at all.
     * @param snapshot - the settings scope snapshot.
     * @returns the resolved row, or `undefined` when unreadable.
     */
    function rowOf(snapshot) {
      if (snapshot.status !== 'ready') return undefined
      return snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
    }

    /** One editable field: label, hint, input, and the override marker. */
    function Field(props) {
      const { t, field, value, overridden, disabled, onChange } = props
      return React.createElement(
        'div',
        { className: 'or-field' },
        React.createElement(
          'div',
          { className: 'or-row' },
          React.createElement('span', { className: 'or-label' }, t(field.label)),
          overridden === true
            ? React.createElement('span', { className: 'or-hint' }, `(${t('overridden')})`)
            : null,
        ),
        React.createElement('input', {
          className: 'or-input',
          type: field.kind === 'integer' ? 'number' : 'text',
          value: value,
          disabled,
          'aria-label': t(field.label),
          onChange: (event) => { onChange(field.key, event.target.value) },
        }),
        React.createElement('span', { className: 'or-hint' }, t(field.hint)),
      )
    }

    /**
     * Build the card component over one bound settings scope.
     * @param scope - the scope bound to the omniroute settings namespace.
     * @param t - translate function bound to this plugin's locale namespace.
     * @returns the component the slot renders.
     */
    function createCard(scope, t) {
      const useOmniRoute = useScope(scope)

      return function OmniRouteCard(props) {
        const snapshot = useOmniRoute()
        const [draft, setDraft] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [status, setStatus] = React.useState(null)

        const row = rowOf(snapshot)
        // A namespace this deployment does not serve renders no trace of itself.
        if (row === undefined) return null

        if (props != null && props.view === 'summary') {
          return row.baseURL === undefined
            ? t('summaryEmpty')
            : t('summary', { baseURL: String(row.baseURL) })
        }

        const disabled = !snapshot.writable
        const shown = draft ?? row
        const user = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {}

        /**
         * Validate and collect the staged edits.
         * @returns an error key, or the ordered path operations to write.
         */
        const collect = () => {
          const ops = []
          for (const field of FIELDS) {
            const value = shown[field.key]
            if (String(value) === String(row[field.key])) continue
            if (field.kind === 'integer') {
              const parsed = Number(value)
              if (!Number.isInteger(parsed) || parsed < field.min || parsed > field.max) {
                return { error: 'numberInvalid' }
              }
              ops.push({ op: 'set', path: [field.key], value: parsed })
              continue
            }
            const text = String(value).trim()
            if (text === '') return { error: 'textInvalid' }
            if (field.kind === 'url' && !/^https?:\/\//u.test(text)) return { error: 'baseUrlInvalid' }
            ops.push({ op: 'set', path: [field.key], value: text })
          }
          return { ops }
        }

        const save = () => {
          setError(null)
          const result = collect()
          if (result.error !== undefined) {
            setError(t(result.error))
            return
          }
          if (result.ops.length === 0) {
            // Nothing moved: an edit that landed back on the stored value is
            // not a change, and the row already holds it.
            setStatus(null)
            return
          }
          setStatus(t('saving'))
          Promise.resolve(scope.mutate(result.ops))
            .then((accepted) => {
              if (accepted === false) {
                setError(t('rejected'))
                setStatus(null)
                return
              }
              setDraft(null)
              setStatus(t('saved'))
            })
            .catch((cause) => {
              setStatus(null)
              setError(t('failed', { message: cause instanceof Error ? cause.message : String(cause) }))
            })
        }

        const reset = () => {
          setDraft(null)
          setStatus(null)
          const ops = Object.keys(user)
            .filter((key) => FIELDS.some((field) => field.key === key))
            .map((key) => ({ op: 'unset', path: [key] }))
          if (ops.length === 0) return
          Promise.resolve(scope.mutate(ops)).catch((cause) => {
            setError(t('failed', { message: cause instanceof Error ? cause.message : String(cause) }))
          })
        }

        const overridden = Object.keys(user).some((key) => FIELDS.some((field) => field.key === key))

        return React.createElement(
          'div',
          { className: 'or-page' },
          ...FIELDS.map((field) => React.createElement(Field, {
            key: field.key,
            t,
            field,
            value: String(shown[field.key] ?? ''),
            overridden: Object.hasOwn(user, field.key),
            disabled,
            onChange: (key, value) => {
              setStatus(null)
              setDraft({ ...shown, [key]: value })
            },
          })),
          React.createElement(
            'div',
            { className: 'or-row' },
            React.createElement(
              'button',
              { type: 'button', className: 'or-button', disabled, onClick: save },
              t('save'),
            ),
            overridden
              ? React.createElement(
                'button',
                { type: 'button', className: 'or-button or-button-quiet', disabled, onClick: reset },
                t('reset'),
              )
              : null,
          ),
          React.createElement(
            'div',
            { className: 'or-status' },
            status ?? (snapshot.writable ? t('persists') : t('readOnly')),
            ' ',
            t('version', { version: VERSION }),
          ),
          error === null ? null : React.createElement('div', { className: 'or-error' }, error),
        )
      }
    }

    /**
     * Mount the browser surface: the OmniRoute card on the Plugins page.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { en, zh }),
        'dsh-omniroute: locale dictionary',
      )

      const scope = ctx.configForms.get(NAMESPACE)
      const Card = createCard(scope, t)

      // The owner declares its own slot; injecting waits for it to exist, so
      // this registration does not depend on plugin load order. The card takes
      // no injected props — it closes over its own bound scope — so the entry
      // declares the documented `locale` namespace and no `inject`.
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-omniroute#omniroute',
        locale: LOCALE_NS,
      }, Card))
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms', 'locale']
    return module.exports
  },
})
