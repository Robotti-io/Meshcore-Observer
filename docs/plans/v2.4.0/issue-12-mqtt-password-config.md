# Issue #12 — MQTT password configuration safety

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/12](https://github.com/Robotti-io/Meshcore-Observer/issues/12)

**Planning decisions (2026-10-02):** The user confirmed that a configured named variable is authoritative and must fail startup if missing/empty; legacy positional lookup applies only when `passwordEnv` is absent. Shared named variables are allowed. `passwordEnv` uses uppercase environment-variable syntax and is valid only for password auth. Preserve the existing requirement that every password-auth broker, including a disabled one, has a non-empty password at startup.

## Implementation Plan

### 1. Feature Summary

Allow a password-authenticated broker to name its password environment variable so secret association follows stable broker configuration rather than array position, while preserving legacy positional variables in v2.x.

### 2. Relevant Existing Architecture

- `src/mqtt/schemas.js` strictly validates broker JSON with `additionalProperties: false` through the shared AJV instance.
- `loadBrokersConfig()` validates and normalizes broker definitions; `src/config/index.js` centrally resolves each password broker's environment variable before validating the final runtime config.
- The resolved secret is held on runtime broker config and passed to `MqttBroker`; startup errors are printed before logger initialization, so neither error path may include the secret value.
- `test/mqtt/brokers-config-loader.test.js` and `test/config/config.test.js` cover schema/config behavior; `.env.example`, `brokers.config.example.json`, and README show the supported credential mappings.

### 3. Proposed Approach

Add optional `auth.passwordEnv` as an environment variable name only. Validate it with the broker JSON Schema: require `^[A-Z_][A-Z0-9_]*$`, and permit it only when `auth.method` is `password`. The broker loader may carry the selector internally until `src/config/index.js` resolves it, then remove it from the final runtime broker object; the runtime config schema can remain unchanged. Resolve only through the injected `env` argument. If the selector exists, use that variable exclusively and fail startup if its value is missing or exactly empty; do not fall back to the positional variable. If no selector exists, preserve current 1-based positional lookup. Do not trim secret values, so whitespace remains a possible literal password. Permit multiple brokers to reference one variable intentionally. Keep the secret value out of errors and logs. Document positional lookup as a legacy fallback that remains supported during v2.x.

### 4. Impacted Areas

- `src/mqtt/schemas.js`, `src/mqtt/brokers-config-loader.js`, `src/config/index.js`.
- `test/mqtt/brokers-config-loader.test.js`, `test/config/config.test.js`.
- `brokers.config.example.json`, `.env.example`, `README.md`, `docs/project_plan.spec.md`.

### 5. Task Breakdown

#### T1: Define precedence and variable-name policy

- [x] Resolved — user decisions are recorded above; remaining compatibility behavior follows the current loader.
- **Objective:** Specify unambiguous secret selection.
- **Specific changes:** Treat a configured named variable as the sole source; fail if it is missing/empty. Use positional lookup only when `passwordEnv` is absent. Allow shared names; require uppercase environment-variable syntax and password auth. Preserve the existing requirement for disabled password-auth brokers to have credentials.
- **Definition of done:** Precedence, reuse, grammar, auth-method scope, empty-value behavior, and backward compatibility are documented.
- **Expected tests / validation:** Review startup error behavior, the broker schema, and final runtime config validation.

#### T2: Implement named password resolution with regression coverage

- [x] Complete — strict validation, central resolution, compatibility behavior, and regression tests are implemented.
- **Objective:** Support stable broker-to-secret mapping while preserving the existing runtime config shape and positional compatibility.
- **Specific changes:** Add `passwordEnv` to the strict broker schema using the approved name pattern and a schema condition that rejects it for `none` and `token` auth. Carry the selector internally to `readBrokers()`, resolve the named variable exclusively when configured, and strip the selector before returning final runtime config. Keep positional lookup when the selector is absent. Reject missing/empty values without printing the secret; preserve exact secret bytes; allow shared variables and retain the credential requirement for disabled brokers.
- **Definition of done:** AJV rejects malformed names and selectors on non-password auth; named credentials remain associated after broker reordering; mixed named/legacy configs work; legacy configs resolve as before; missing/empty named values fail without fallback or secret disclosure; the runtime config shape remains unchanged.
- **Expected tests / validation:** [x] Focused broker-loader and config tests passed (54 tests). [x] `npm test` passed (47 files / 483 tests). [x] `npm run test:ci` passed (47 files / 483 tests). [x] `npm run lint` and `git diff --check` passed.
- **T2 result (2026-10-02):** The broker schema accepts only uppercase `passwordEnv` names on password-auth brokers; `loadConfig()` resolves named values without positional fallback, retains positional behavior when absent, and removes the selector from final runtime config. Regression tests cover reordering, mixed mappings, shared variables, absent/empty named values, error redaction, disabled brokers, and exact secret whitespace preservation.

#### T3: Document operator migration path

- [x] Complete — broker JSON example, README, `.env.example`, and project plan spec show named mapping and the supported positional fallback.
- **Objective:** Make stable mapping discoverable while preserving existing deployments.
- **Specific changes:** Keep the two OKIMesh `mqtt1`/`mqtt2` examples anonymous; include MeshMapper and LetsMesh as separate device-signed token-auth broker entries; add two TLS-enabled password-auth placeholders (`mqtt1.example.com` and `mqtt2.example.com`) with distinct `passwordEnv` variables mirrored in `.env.example` and the project plan spec. Label positional variables legacy but supported in v2.x.
- **Definition of done:** Documentation shows that JSON contains a variable name, never a secret, and explains both mapping modes accurately.
- **Expected tests / validation:** [x] Broker example passed the strict loader test (16 tests in that file). [x] Named variable names in JSON match `.env.example` and the project plan spec; precedence guidance matches `src/config/index.js`. [x] Full suite passed (47 files / 484 tests) before the password-example expansion. [x] After adding both password-auth examples, the focused broker-loader test (16 tests), lint, and `git diff --check` passed.
- **T3 result (2026-10-02):** README recommends stable named mapping and explains fail-closed precedence, variable reuse, and the positional legacy fallback. `brokers.config.example.json` shows two anonymous OKIMesh endpoints, MeshMapper and LetsMesh token-authenticated endpoints, and two TLS-enabled password-auth placeholders mapped to distinct environment variables. Token auth uses no static password variable. Broker details link to the MeshCore-HA setup and MeshMapper's broker overview.

### 6. Risks and Edge Cases

- Incorrect precedence can silently bind a broker to a different secret.
- Empty strings are rejected; a whitespace-only password remains valid because password bytes are not trimmed. Shared named variables are permitted intentionally.
- Error rendering must redact the actual secret and should not echo arbitrary secret values.
- User-defined variable names must still be read only through central config, not by feature modules.
- The selector is stripped before final runtime config validation, keeping the existing runtime config shape unchanged.

### 7. Open Questions / Assumptions

- [x] A configured `passwordEnv` is authoritative; there is no positional fallback if its value is absent/empty. Positional resolution remains for configs without `passwordEnv`.
- [x] Multiple brokers may intentionally reference the same environment variable.
- [x] Names follow `^[A-Z_][A-Z0-9_]*$`; the selector is valid only with password auth.
- [x] Missing and exactly empty passwords fail startup; secret values are not trimmed or exposed in errors/logs. Disabled password-auth brokers continue to require a password, matching current behavior.
- **Assumption:** No password rotation or secret-store integration is introduced.

### 8. Suggested Execution Order

1. T1 — resolve policy before implementation. **Complete during planning.**
2. [x] T2 — implement strict named selector validation, central resolution, and regression coverage.
3. [x] T3 — update operator examples and compatibility documentation after behavior is verified.
