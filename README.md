# dsh-omniroute

OmniRoute's own API, inside DeepSeek Harness. The router that fronts every
upstream account knows things the OpenAI-compatible `/v1` surface does not: which
models it can serve *right now*, which accounts it holds, and what each of those
accounts has left. This plugin serves all three as JSON routes on the harness's
own origin, behind the same trust fence as the harness's browser routes, with the
OmniRoute API key never leaving the host process.

## What you get

- **The live catalog, not `/v1/models`.** `available` and `vision` per
  model, with `?available=1`, `?q=`, and `?provider=` to narrow it.
- **The account inventory.** Every upstream connection with its id, provider, switch
  state, and whether it publishes quota.
- **Per-connection quota.** Plan and windows for each connection that publishes one.
- **An explicit picker sync.** `?sync=1` merges the available models into a provider
  route's settings, so the model picker learns them. It never runs on a timer.
- **The key stays on the host.** Routes answer formatted JSON only.

## Install

> **Install it as a bundle.** `dsh plugin add …` mounts the row from the
> package's own patch layer, which is what the settings editor can write to. A
> row added with `--patch` is an overlay: it disappears at the next start, and
> the Plugins card cannot save into it (the editor refuses a write an overlay
> would win).

```sh
dsh plugin --profile web add github:maci0/dsh-omniroute#v0.8.0
```

Pin a release tag: a bare `github:` spec floats on `main`. To upgrade, run the same command with the newer tag, then restart `dsh web` (bundle layers compose at boot).

Do **not** also paste the `id: omniroute` row from `cordis.patch.yml` into the
profile's own patch: `insert` does not dedupe ids.

## Configure

Every field is editable from the Web client: open **Plugins**, then the
**omniroute** row, then **Configure**. The card validates the URL, the non-empty
references, and the numeric bounds before the write, saves every changed field
in one update, and offers **Reset to defaults** for the fields you overrode.
Every field is `volatile()`, so a save reaches the running routes: each is read
per request and a settings write drops the served readings, so a new origin or
cache window applies to the next poll instead of a restart.

The same row can be set by hand in the profile's own `cordis.patch.yml`; a patch
replaces the targeted row's whole `config`, so restate every key you keep:

```yaml
- id: omniroute
  config:
    baseURL: http://192.168.0.100:20128/v1   # origin is used; the /v1 path is dropped
    apiKeyEnv: OMNIROUTE_API_KEY             # credential reference, then that env var
    timeoutMs: 10000                         # per OmniRoute request
    cacheSeconds: 30                         # how long one reading is served from cache
    syncNamespace: llm-pi-ai                 # where ?sync=1 writes
    syncProvider: omniroute                  # which provider route it writes for
```

| Key | Default | Bounds | Meaning |
|---|---|---|---|
| `baseURL` | `http://localhost:20128` | absolute http(s) | The deployment. Its origin addresses OmniRoute's management API, so a `/v1` suffix is fine and ignored. A value without an http(s) scheme fails at load, and a live edit to one makes every route answer a configuration error without asking anything; no default origin is guessed. |
| `apiKeyEnv` | `OMNIROUTE_API_KEY` | non-empty | Credential reference resolved through `ctx.credentials`, falling back to the launcher's environment. The key needs the scopes the endpoints use: this box's key carries `self:usage` and `manage`. |
| `timeoutMs` | `10000` | 1–60000 | Deadline for each OmniRoute request, including the connection listing. |
| `cacheSeconds` | `30` | 0–3600 | How long one reading is served before OmniRoute is asked again. `0` re-asks every time. |
| `syncNamespace` | `llm-pi-ai` | non-empty | Settings namespace `?sync=1` merges into. |
| `syncProvider` | `omniroute` | non-empty | Provider route inside that namespace. |

## Routes

- `GET /omniroute/models`: the live catalog, with `available` and `vision` per
  model, and `?available=1`, `?q=<text>`, `?provider=<key>` to narrow it.
  `?sync=1` also copies the available models into a provider route's settings,
  which is how the model picker learns them.
- `GET /omniroute/connections`: every upstream connection, with the id, the
  provider, whether it is switched on, and whether it publishes quota.
- `GET /omniroute/quota`: the plan and windows of every connection that
  publishes one.

Every route also answers `?refresh=1`, which ignores the cache for that read.
`fetchedAt` is when OmniRoute answered, so a reading served from cache keeps the
time it was taken.

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
is deliberately explicit rather than automatic: a background writer that
rewrites a provider row on a timer is not something a plugin should do to a
settings document it does not own.

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

The write is a merge, so fields the row already carries (`apiKeyEnv`, `baseURL`,
`compat`) survive; only `models` is replaced.

## How it works

- **The endpoints are OmniRoute's own.** They were read off a running `v3.8.50`
  server rather than guessed: `GET /api/openapi/spec` lists 361 endpoints, and
  `GET /api/agent-skills` indexes them per area. The paths people commonly try
  (`/api/balance`, `/api/usage`, `/api/quota`, `/key/info`) are not among them
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
- **Readings are cached** for `cacheSeconds`: the catalog, and the connection
  listing together with its windows (both connection routes serve that one
  reading, so they never disagree). Concurrent callers share one in-flight read,
  so a refresh loop cannot multiply requests to the router.
- **Every route checks the trust fence first.** The plugin injects the
  composition's `connection` service and asks `requestRejection` before anything
  else; a composition without that service never mounts the routes.
- **The key stays in this process.** Routes answer formatted JSON only: no key,
  no Authorization header. A refusal is this plugin's own one-line message
  (HTTP status, timeout, unreachable, non-JSON body), never the router's body;
  a failure inside another service (credentials, settings) is logged on the
  host and answered generically.

## Limits

- **One quota read is one listing plus one request per visible connection.** On
  the reference box that is 21 requests, cached for `cacheSeconds`. A deployment
  with many connections should raise `cacheSeconds`.
- **Quota is read per connection, not per route.** A route served by OmniRoute
  spends whichever account the router picks, so no single figure belongs to it.
  `dsh-quota-check`'s OmniRoute probe renders the fullest window across
  connections for exactly that reason.
- **No statusbar chip.** The browser half ships the row's configuration card
  only; the routes are the read surface, and `dsh-quota-check` draws the chip.
- **The catalog carries no capacities.** `/api/models` reports availability and
  vision but no context window, so a synced model entry sets only `id` and
  `name`. Set capacities in the provider row when they matter.
- **`?sync=1` writes a namespace this plugin does not own.** It merges into
  `syncNamespace` (default `llm-pi-ai`) because that is where the picker reads
  from. Point it elsewhere, or leave it alone, when that route is not yours.
- **Read-only.** Creating keys, connections, and combos is out of scope; nothing
  here mutates the router.

## Development

dsh loads plugins on Node `^22.19.0 || >=24.0.0`; development and tests run on bun.

```sh
bun install          # first run only (typescript, @types/node, cordis, carrier, schemastery)
bun run typecheck
bun test             # parsers, the client, both route halves, and a real-composition boot
bun run build        # tsc -> lib/*.js
```

For local development, `dsh plugin --profile <name> add <path-to-checkout>`
(after `bun run build`), then restart `dsh web`.

`bun test` includes the real-composition case: the plugin mounts into a real
Cordis `Context` beside the real HTTP carrier on an OS-assigned port, a route is
driven over real HTTP with the settings write observed, disposing the fiber
must withdraw every route, and no route exists until the trust fence is mounted.

## Licence

MIT. See [LICENSE](LICENSE).
