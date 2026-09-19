# dsh-omniroute

OmniRoute's own API, inside DeepSeek Harness. The router that fronts every
upstream account knows things the OpenAI-compatible `/v1` surface does not: which
models it can serve *right now*, which accounts it holds, and what each of those
accounts has left. This plugin serves all three as JSON routes on the harness's
own origin, behind the same trust fence as the harness's browser routes, with the
OmniRoute API key never leaving the host process.

- `GET /omniroute/models` — the live catalog, with `available` and
  `supportsVision` per model, and `?available=1`, `?q=<text>`, `?provider=<key>`
  to narrow it. `?sync=1` additionally copies the available models into a
  provider route's settings, which is how the model picker learns them.
- `GET /omniroute/connections` — every upstream connection, with the id, the
  provider, whether it is switched on, and whether it publishes quota.
- `GET /omniroute/quota` — the plan and windows of every connection that
  publishes one.

Every route also answers `?refresh=1`, which ignores the cache for that read.

## What you get

- **The live catalog, not `/v1/models`.** `available` and `supportsVision` per
  model, with `?available=1`, `?q=`, and `?provider=` to narrow it.
- **The account inventory.** Every upstream connection with its id, provider, switch
  state, and whether it publishes quota.
- **Per-connection quota.** Plan and windows for each connection that publishes one.
- **An explicit picker sync.** `?sync=1` merges the available models into a provider
  route's settings, so the model picker learns them — never on a timer.
- **The key stays on the host.** Routes answer formatted JSON only.

## Install

```sh
dsh plugin --profile web add github:maci0/dsh-omniroute
dsh plugin --profile web update dsh-omniroute   # refresh later
```

For work on this checkout, `dsh plugin --profile web add link:/path/to/dsh-omniroute`
also works: `link:` keeps the profile pointing at the working copy, so
`npm run build` is what ships a source change. Then restart `dsh web`: `dsh
plugin add` appends the package to `dsh.profile.bundles`, and bundles are frozen
at boot, so a restart is what mounts the plugin. Do **not** also paste the `id: omniroute` row from
`cordis.patch.yml` into the profile's own patch: `insert` does not dedupe ids.

## Configure

The row schema is the exported `Config`. Override the row from the profile's own
`cordis.patch.yml`; a patch replaces the targeted row's whole `config`, so
restate every key you keep:

```yaml
- id: omniroute
  config:
    baseURL: http://192.168.0.100:20128/v1   # origin is used; the /v1 path is dropped
    apiKeyEnv: OMNIROUTE_API_KEY             # credential reference, then that env var
    timeoutMs: 10000                         # per OmniRoute request
    cacheSeconds: 30                         # one reading per route, served from cache
    syncNamespace: llm-pi-ai                 # where ?sync=1 writes
    syncProvider: omniroute                  # which provider route it writes for
```

| Key | Default | Meaning |
|---|---|---|
| `baseURL` | `http://localhost:20128` | The deployment. Its origin addresses OmniRoute's management API, so a `/v1` suffix is fine and ignored. |
| `apiKeyEnv` | `OMNIROUTE_API_KEY` | Credential reference resolved through `ctx.credentials`, falling back to the launcher's environment. The key needs the scopes the endpoints use: this box's key carries `self:usage` and `manage`. |
| `timeoutMs` | `10000` | Deadline for each OmniRoute request, including the connection listing. |
| `cacheSeconds` | `30` | How long one route's reading is served before OmniRoute is asked again. `0` re-asks every time. |
| `syncNamespace` | `llm-pi-ai` | Settings namespace `?sync=1` merges into. |
| `syncProvider` | `omniroute` | Provider route inside that namespace. |

## Routes

```
http://127.0.0.1:3080/omniroute/models?available=1&q=claude
```

`/omniroute/models` answers with the catalog and its counts:

```json
{
  "status": "ok",
  "provider": "omniroute",
  "origin": "http://192.168.0.100:20128",
  "fetchedAt": 1789793193906,
  "counts": { "total": 525, "available": 95, "shown": 95 },
  "models": [
    { "id": "cc/claude-opus-5", "provider": "cc", "name": "Claude Opus 5", "available": true, "vision": true }
  ]
}
```

`/omniroute/quota` answers with the connection list and one entry per window:

```json
{
  "status": "ok",
  "windows": [
    {
      "connection": "acbe586b-7488-44c4-b8d1-de4982c18ed7",
      "provider": "deepseek",
      "plan": "DeepSeek",
      "window": "credits_usd",
      "used": 0,
      "total": 0,
      "remaining": 91.27,
      "remainingPercent": 100,
      "unlimited": true,
      "currency": "USD",
      "limitReached": false
    }
  ],
  "limitReached": []
}
```

### Filling the model picker

The picker reads a route's models from `settings.yaml`, so the live catalog only
reaches it when something writes them there. That is what `?sync=1` does, and it
is deliberately explicit rather than automatic — a background writer that
rewrites a provider row on a timer is not something a plugin should do to a
settings document it does not own:

```sh
curl 'http://127.0.0.1:3080/omniroute/models?available=1&sync=1'
```

That fetches the catalog, keeps the `available` models (after `?q=` and
`?provider=`, so a narrowed sync is possible), and merges
`providers.<syncProvider>.models` into `syncNamespace`. The reply names what it
wrote:

```json
"synced": { "namespace": "llm-pi-ai", "path": "providers.omniroute.models", "count": 95 }
```

The write is a merge, so fields the row already carries — `apiKeyEnv`, `baseURL`,
`compat` — survive; only `models` is replaced.

## How it works

- **The endpoints are OmniRoute's own.** They were read off a running `v3.8.50`
  server rather than guessed: `GET /api/openapi/spec` lists 361 endpoints, and
  `GET /api/agent-skills` indexes them per area. The paths people commonly try —
  `/api/balance`, `/api/usage`, `/api/quota`, `/key/info` — are not among them
  (`/key/info` is the web app's HTML fallback), which is why earlier attempts at
  this router found nothing.
- **The catalog comes from `/api/models`, not `/v1/models`.** Both answer, but
  only the management listing carries `available` and `supportsVision`, and only
  it says which models are servable now instead of which have ever existed.
- **Quota is per connection, because OmniRoute holds the accounts.** The router
  publishes no figure for itself, so the plugin lists connections, skips the ones
  that are switched off or hide their quota, and asks `/api/usage/<id>` for the
  rest. A connection that fails to answer contributes no window instead of
  failing the read. `/api/quota/plans` resolves plans without consumption and
  `/api/quota/pools` is empty unless the deployment defines pools, so neither is
  read here.
- **Readings are cached per route** for `cacheSeconds`, and concurrent callers
  share one in-flight read, so a refresh loop cannot multiply requests to the
  router.
- **The key stays in this process.** Routes answer formatted JSON only: no key,
  no Authorization header, and a refusal is shortened to one line rather than
  passed through as the router's own body.

## Development

```sh
npm install          # first run only (typescript, @types/node, cordis, carrier, schemastery)
npm run typecheck
npm test             # parsers, the client, both route halves, and a real-composition boot
npm run build        # tsc -> lib/*.js
```

`npm test` includes the real-composition case: the plugin mounts into a real
Cordis `Context` beside the real HTTP carrier on an OS-assigned port, a route is
driven over real HTTP with the settings write observed, and disposing the fiber
must withdraw every route.

## Limits

- **One quota read is one listing plus one request per visible connection.** On
  the reference box that is 21 requests, cached for `cacheSeconds`. A deployment
  with many connections should raise `cacheSeconds`.
- **Quota is read per connection, not per route.** A route served by OmniRoute
  spends whichever account the router picks, so no single figure belongs to it.
  `dsh-quota-check`'s OmniRoute probe renders the fullest window across
  connections for exactly that reason.
- **No browser half.** There is no card and no statusbar chip here; the routes
  are the surface. `dsh-quota-check` draws the chip.
- **The catalog carries no capacities.** `/api/models` reports availability and
  vision but no context window, so a synced model entry sets only `id` and
  `name`. Set capacities in the provider row when they matter.
- **`?sync=1` writes a namespace this plugin does not own.** It merges into
  `syncNamespace` (default `llm-pi-ai`) because that is where the picker reads
  from. Point it elsewhere, or leave it alone, when that route is not yours.
- **Read-only.** Creating keys, connections, and combos is out of scope; nothing
  here mutates the router.

## Licence

MIT. See [LICENSE](LICENSE).
