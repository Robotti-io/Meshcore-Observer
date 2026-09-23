# AGENTS.md — meshcore-observer

## Language and module rules

- JavaScript only. Python and TypeScript are prohibited.
- ES modules (`"type": "module"`), not CommonJS.
- Prefer small, explicit modules over large service classes.

## Validation

- Inbound structured data crossing a trust boundary (environment variables,
  radio events, MQTT-bound payloads) must be validated with centralized
  strict JSON Schema via the shared AJV instance in `src/validation/ajv.js`
  before business logic executes.
- Schemas default to `additionalProperties: false`.

## Configuration

- All environment variable reads happen in `src/config/index.js`. Feature
  modules receive configuration through function/constructor arguments and
  must never read `process.env` directly.
- Configuration errors must terminate startup before any hardware or network
  side effect occurs.

## Logging

- Use the structured logger in `src/logging/logger.js` with stable logical
  `source` values (see `docs/project_plan.spec.md` Section 8).
- Never log JWTs, MQTT passwords, private keys, bearer tokens, or other
  session/authentication secrets. The logger auto-redacts known-sensitive
  metadata keys, but do not rely on that as the only safeguard — avoid
  passing secret values into log metadata in the first place.

## Dependencies

- Approved runtime dependencies: `@liamcottle/meshcore.js`, `mqtt`, `ajv`.
- Approved dev dependency: `eslint` (+ `@eslint/js`).
- Do not add further dependencies (runtime or dev) without explicit human
  approval. In particular, no second MeshCore decoding library, no HTTP
  framework, no logging framework, no third-party persistence/database
  library — `node:sqlite` (a Node built-in, not an npm package) is the one
  approved storage engine; see "Persistence" below.

## Persistence

- `node:sqlite` (`src/metrics/store.js`'s `MetricsStore`) is this
  observer's core, always-on data store. It opens unconditionally at
  startup, independent of whether the optional HTTP dashboard
  (`PACKETCAPTURE_METRICS_UI_ENABLED`) is on — that flag only gates the
  dashboard's HTTP server, never whether data gets persisted.
- Node >=22.13.0 (required for `node:sqlite`) is therefore a hard runtime
  requirement, not just a `package.json` aspiration: startup fails if the
  store can't be opened (same as an invalid configuration value — see
  "Configuration" above).
- A feature's state belongs in this store, not an in-memory structure,
  whenever it's queryable data the dashboard or a bot command reads back
  (e.g. the node/repeater registry `!lookup` uses, bot reply-lifecycle
  counts). Purely transient, operational state that has no value once
  handled — an anti-duplicate cache's recent-hash window, a reply queue's
  not-yet-sent items — stays in memory; it's runtime bookkeeping, not a
  dataset.
- Raw packet data is the deliberate exception: this observer ships it to
  the configured MQTT broker(s) per the observer capability
  specification, which is its persistence — it is not additionally stored
  locally.

## Protected boundaries requiring human approval

Authentication, logging contracts, public APIs, dependencies, storage, and
deployment/CI changes require explicit approval before implementation.

## Workflow

- Implement one approved task/phase at a time.
- Make small, auditable, reviewable changes with tests.
- Surface risky ambiguity and stop rather than guessing or silently
  broadening scope.
- Inspect `package.json` before running project workflows; use
  `npm run <script>` rather than ad-hoc commands.

## Commands

| Purpose | Command |
| --- | --- |
| Install dependencies | `npm install` |
| Start | `npm start` |
| Start with auto-restart on file change | `npm run dev` |
| Run tests | `npm test` |
| Run lint | `npm run lint` |

Local development reads `.env.local` (see `.env.example`) via Node's
`--env-file-if-exists` flag. Production/container deployments must supply
configuration through the real process environment.
