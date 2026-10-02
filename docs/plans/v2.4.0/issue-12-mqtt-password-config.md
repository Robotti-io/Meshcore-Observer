# Issue #12 — MQTT password configuration safety

GitHub issue: [https://github.com/Robotti-io/Meshcore-Observer/issues/12](https://github.com/Robotti-io/Meshcore-Observer/issues/12)

## Implementation Plan

### 1. Feature Summary

Allow a password-authenticated broker to name its password environment variable so secret association follows stable broker configuration rather than array position, while preserving legacy positional variables in v2.x.

### 2. Relevant Existing Architecture

- `src/mqtt/schemas.js` strictly validates broker JSON with `additionalProperties: false`.
- `loadBrokersConfig()` validates and normalizes broker definitions; `src/config/index.js` maps each password broker to `PACKETCAPTURE_MQTT<n>_PASSWORD`.
- The resolved secret is held on runtime broker config and passed to `MqttBroker`; logger rules prohibit secrets in logs.
- `test/mqtt/brokers-config-loader.test.js` and `test/config/config.test.js` cover schema/config behavior; `.env.example`, broker example JSON, and README document positional mapping.

### 3. Proposed Approach

If adopted, add optional `auth.passwordEnv` as an environment variable name only, validate it strictly with the central AJV schema, and resolve the value from the `env` object passed into `loadConfig()`. Explicit named mapping should take precedence; absent mapping retains current 1-based positional lookup. Validate the variable-name grammar and non-empty secret without ever including the secret value in an error or log. Preserve compatibility and document the legacy fallback.

### 4. Impacted Areas

- `src/mqtt/schemas.js`, `src/mqtt/brokers-config-loader.js`, `src/config/index.js`.
- `test/mqtt/brokers-config-loader.test.js`, `test/config/config.test.js`.
- `brokers.config.example.json`, `.env.example`, `README.md`.

### 5. Task Breakdown

#### T1: Define precedence and variable-name policy

- **Objective:** Specify unambiguous secret selection.
- **Specific changes:** Decide whether named env mapping overrides or rejects simultaneous positional config; specify allowed env-name characters and behavior when unset/empty.
- **Definition of done:** Backward-compatible precedence and error behavior are documented.
- **Expected tests / validation:** Review current startup errors and schema conventions.

#### T2: Add strict schema and secret resolution

- **Objective:** Resolve credentials from configuration without exposing secret material.
- **Specific changes:** Add optional `passwordEnv`; normalize it; resolve named values before positional fallback; retain early config failure and avoid logging values.
- **Definition of done:** Named mapping works independently of broker order; old configs still resolve by position.
- **Expected tests / validation:** Tests for named variable, missing/empty variable, invalid name, reordering, mixed named/legacy brokers, and legacy compatibility.

#### T3: Document operator migration path

- **Objective:** Make safer mapping discoverable without breaking deployments.
- **Specific changes:** Update example broker JSON, `.env.example`, and README; identify positional variables as legacy but supported.
- **Definition of done:** Documentation gives clear named and legacy examples without secrets in JSON.
- **Expected tests / validation:** JSON example parses through the strict loader; documentation variables agree with config behavior.

### 6. Risks and Edge Cases

- Incorrect precedence can silently bind a broker to a different secret.
- Empty strings and duplicate variable names may be configured accidentally.
- Error rendering must redact the actual secret and should not echo arbitrary secret values.
- User-defined variable names must still be read only through central config, not by feature modules.

### 7. Open Questions / Assumptions

- Should explicit `passwordEnv` take precedence over any positional value, or should configuring both be rejected?
- Should the same named variable be permitted for multiple brokers?
- Assumption: no password rotation or secret-store integration is introduced.

### 8. Suggested Execution Order

1. T1 — define precedence and grammar.
2. T2 — implement AJV validation and central resolution.
3. T3 — update examples and compatibility documentation.
