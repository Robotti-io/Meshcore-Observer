# Feature: Simplified Setup

## Summary

Create a dramatically simpler installation, onboarding, configuration, and reconfiguration experience for MeshCore Observer.

MeshCore Observer should be approachable by members of the broader MeshCore and amateur radio communities who may be comfortable operating radios and MeshCore devices but may not be comfortable cloning Git repositories, editing environment files, maintaining JSON configuration, installing Node.js applications, or configuring operating-system services.

The desired experience is closer to onboarding a consumer appliance than deploying a traditional Node.js application.

A user should be able to:

1. Install MeshCore Observer through a simple platform-appropriate setup process.
2. Launch a local web-based onboarding experience.
3. Configure the radio, MQTT brokers, bots, dashboard, and other supported settings through guided forms rather than manually editing files.
4. Validate the configuration before activating it.
5. Configure MeshCore Observer to run persistently and automatically on the local machine.
6. Return to the same interface later to safely reconfigure the installation without uninstalling or reinstalling the application.
7. Diagnose common setup problems using understandable, actionable guidance.

Windows should be treated as the primary desktop installation target because a significant portion of the expected community is likely to operate MeshCore Observer from Windows machines.

Linux must also be supported, particularly for Raspberry Pi and other small always-on systems commonly used in amateur radio installations.

The implementation should simplify the user experience without unnecessarily replacing MeshCore Observer's existing configuration contracts underneath it. Wherever practical, the setup interface should generate, validate, and safely maintain the same backend configuration that the application already understands.

---

## Goals

- Make initial installation approachable for users with limited command-line or software-development experience.
- Eliminate the requirement for normal users to manually copy example configuration files before first use.
- Eliminate the requirement for normal users to manually edit `.env`, JSON, or similar configuration formats.
- Provide a guided local web interface for configuring MeshCore Observer.
- Use plain-language explanations and sensible defaults throughout onboarding.
- Validate configuration before attempting normal application startup.
- Detect common configuration and environment problems before they become runtime failures.
- Support Windows as a first-class installation and service-hosting platform.
- Support Linux installations, including Raspberry Pi-class devices.
- Configure the application to start automatically using appropriate operating-system facilities.
- Allow existing installations to be reconfigured without uninstalling or reinstalling MeshCore Observer.
- Safely preserve working configuration when changes fail validation or cannot be applied.
- Make application upgrades independent from user configuration wherever practical.
- Provide straightforward backup/export capabilities for configuration.
- Allow experienced operators to retain access to advanced settings and underlying configuration where appropriate.
- Reuse existing configuration validation logic instead of creating a second incompatible interpretation of configuration.
- Keep setup and configuration local-first and avoid requiring a hosted cloud management service.

---

## Non-Goals

- Do not require users to understand Git, npm, environment variables, JSON syntax, or operating-system service-management internals for a normal installation.
- Do not replace the entire existing runtime configuration model solely for the purpose of creating a friendlier setup experience.
- Do not combine every environment setting, broker setting, bot setting, and secret into a new monolithic configuration format unless a separate architectural review establishes a compelling need.
- Do not require a user to uninstall and reinstall MeshCore Observer simply to change configuration.
- Do not require Internet-hosted configuration or a cloud account to administer a local Observer.
- Do not expose the setup interface to the local network or Internet by default.
- Do not store secrets in browser-local storage, URLs, logs, exported diagnostic reports, or other inappropriate locations.
- Do not allow partially written configuration files to replace a known-working configuration.
- Do not silently apply invalid configuration.
- Do not hide advanced configuration from experienced operators who intentionally want to manage it.
- Do not introduce a heavyweight general-purpose administration platform merely to support installation and configuration.
- Do not assume that Windows and Linux must use the same underlying service-management mechanism.
- Do not require the normal Observer runtime to successfully initialize radio, MQTT, bots, or other network services before the setup interface can be used.

---

## Scope 1: Simple Cross-Platform Installation

### 1.1 Problem

The current installation process is appropriate for technically experienced users but requires knowledge that should not be necessary for someone who simply wants to operate an Observer.

A user may currently need to understand concepts such as:

- Git repositories.
- Node.js and npm.
- Command-line navigation.
- Example configuration files.
- Environment files.
- JSON configuration.
- Startup scripts.
- Scheduled Tasks or other operating-system service mechanisms.

For many amateur radio operators, these requirements create a larger adoption barrier than the actual MeshCore-specific configuration.

Installation should therefore become an intentional product experience rather than a set of developer-oriented setup instructions.

---

### 1.2 User Stories

#### 1.2.1 Simple installation entry point

As a new Observer operator, I want a clear setup package or script for my operating system so that I can install MeshCore Observer without manually reproducing a developer environment.

#### 1.2.2 Windows-first experience

As a Windows user, I want the installation process to handle the common Windows-specific setup steps for me so that I do not need to understand Node.js application deployment or Windows Scheduled Task/service configuration.

#### 1.2.3 Linux / Raspberry Pi installation

As a Linux or Raspberry Pi user, I want a similarly guided installation process so that I can operate MeshCore Observer on an inexpensive always-on system.

#### 1.2.4 Existing environment awareness

As an experienced user, I want the installer to recognize when compatible prerequisites are already available so that it does not unnecessarily overwrite or duplicate my environment.

#### 1.2.5 Clear failures

As a user, I want installation problems explained in understandable language with corrective guidance rather than receiving only raw command output or stack traces.

---

### 1.3 Functional Requirements

#### 1.3.1 Platform detection

The installation process should identify the supported operating-system environment and use an appropriate installation path.

Initial supported targets should include at least:

- Windows.
- Common Linux distributions appropriate for running Node.js.
- Raspberry Pi OS or comparable Debian-based Raspberry Pi environments.

The exact supported operating-system/version matrix should be documented.

#### 1.3.2 Installation prerequisites

The installer should determine which prerequisites are required and whether they are already present.

Potential prerequisites include:

- Supported Node.js runtime.
- Required operating-system permissions.
- Application data/configuration directory access.
- Service-management facilities.
- Browser availability for local web onboarding.

The installer should not silently make broad system changes unrelated to MeshCore Observer.

#### 1.3.3 Installation layout

Application code and user-owned configuration should be cleanly separated.

An application update should not normally overwrite:

- User configuration.
- Broker definitions.
- Bot definitions.
- Secrets.
- Metrics databases.
- Historical data.
- Setup state.

This separation should make upgrades and reconfiguration safer.

#### 1.3.4 Launch onboarding

At the end of a successful installation, the user should have an obvious way to launch the local onboarding experience.

Where practical, the installer may automatically open the user's default browser to the local setup interface.

The user should also have a documented command or shortcut that can reopen the configuration interface later.

---

## Scope 2: Web-Based Guided Onboarding

### 2.1 Problem

MeshCore Observer currently relies on backend configuration files that are appropriate for machine-readable configuration but are unnecessarily intimidating for many end users.

Users should not need to manually copy and edit example files to get started.

The onboarding system should present the configuration as understandable questions and choices while continuing to produce valid backend configuration for the Observer runtime.

---

### 2.2 User Stories

#### 2.2.1 Guided first-run experience

As a new user, I want MeshCore Observer to guide me through the minimum information necessary to get running so that I am not presented with every advanced option at once.

#### 2.2.2 Plain-language settings

As a user who is not a software developer, I want configuration fields explained in normal MeshCore/operator language so that I understand what I am changing.

#### 2.2.3 Sensible defaults

As a user, I want safe recommended defaults automatically selected where possible so that I only need to make decisions that actually matter to my installation.

#### 2.2.4 Progressive disclosure

As a new user, I want advanced settings hidden until I need them so that the setup process remains approachable.

As an experienced user, I want to reveal advanced options when necessary.

#### 2.2.5 Resume setup

As a user, I want to return to an incomplete onboarding session so that I do not need to restart the entire process after pausing to find credentials, radio information, or other configuration details.

---

### 2.3 Setup Mode

The onboarding interface must be capable of running before the normal Observer application is fully configured.

This is important because normal startup should continue to reject invalid configuration before hardware or network side effects occur.

A dedicated setup mode should therefore provide enough functionality to:

1. Start a local configuration server.
2. Present the onboarding UI.
3. Load existing configuration where available.
4. Accept proposed changes.
5. Validate proposed configuration.
6. Perform explicitly requested connectivity checks.
7. Write valid configuration.
8. Transition the installation into normal runtime operation.

Setup mode should not require:

- A working radio connection.
- A configured MQTT broker.
- A configured bot.
- An already-valid production configuration.

---

### 2.4 Setup Interface Security

The onboarding/configuration interface should be treated as an administrative surface.

Requirements include:

- Bind to loopback/local host by default.
- Do not expose the setup UI to LAN interfaces by default.
- Do not expose secrets in URLs.
- Do not include secrets in browser history.
- Do not log secret values.
- Do not return stored secrets unnecessarily through configuration APIs.
- Ensure configuration APIs validate all inbound structured data.
- Clearly separate intentionally displayed configuration from protected secret values.
- Avoid requiring a remote cloud account or hosted management service.

If remote administration is ever supported, it should be separately designed and reviewed rather than being an accidental consequence of the local setup server.

---

## Scope 3: Guided Configuration

### 3.1 Problem

MeshCore Observer currently has multiple configuration domains that make sense internally but should not require users to understand the underlying file layout.

The web onboarding interface should provide guided configuration for the supported application features while generating the appropriate backend files.

---

### 3.2 Radio Configuration

The setup interface should guide the user through selecting and configuring the Observer's radio connection.

Potential flow:

1. Select connection type.
2. Choose or enter the appropriate serial/TCP information.
3. Validate required fields.
4. Where safely possible, test the selected connection.
5. Clearly report success or actionable failure information.

The interface should explain common concepts without requiring the user to know the corresponding environment variable names.

---

### 3.3 MQTT Broker Configuration

The setup interface should allow users to:

- Add a broker.
- Edit a broker.
- Remove a broker.
- Configure supported authentication modes.
- Enter credentials securely.
- Validate configuration.
- Test connectivity when explicitly requested.
- See an understandable result of the connectivity test.

The user should not need to manually construct `brokers.config.json`.

Secret handling must preserve existing security expectations.

---

### 3.4 Bot Configuration

The setup interface should allow users to configure supported bot settings without manually constructing `bots.config.json`.

The UI should:

- Present supported bot settings through forms.
- Validate required values.
- Explain command/trigger configuration where appropriate.
- Allow bots to be added, modified, disabled, or removed.
- Preview or summarize the resulting bot configuration before applying it.

Advanced or uncommon configuration may remain available through an advanced section.

---

### 3.5 General Observer Configuration

The setup interface should also expose supported general settings such as:

- Dashboard configuration.
- Logging level where appropriate.
- Observer identity/contact settings.
- Retention or metrics-related settings where supported.
- Future telemetry/reporting configuration introduced by other v2.5.0 work.
- Other centrally supported application settings.

The UI should be generated or maintained in a way that reduces the likelihood of the setup model drifting away from the application's actual configuration validation.

---

## Scope 4: Configuration Doctor & Preflight Validation

### 4.1 Problem

A guided setup interface is only useful if it can tell the user whether the resulting installation is actually usable.

Configuration problems should be detected before normal runtime startup whenever practical.

---

### 4.2 User Stories

As a user, I want MeshCore Observer to check my configuration before applying it so that mistakes are caught safely.

As a user, I want error messages to explain what is wrong and how I can correct it.

As an experienced operator, I want to rerun configuration diagnostics later without having to modify anything.

---

### 4.3 Validation Requirements

The configuration doctor should be able to validate, as appropriate:

- Required configuration values.
- Configuration schema correctness.
- Supported connection type.
- Required files/directories.
- File permissions.
- Radio configuration.
- MQTT broker definitions.
- Bot configuration.
- Dashboard configuration.
- Service-management prerequisites.
- Configured paths.
- Secret references.
- Platform-specific requirements.

Existing application validation logic should be reused wherever practical.

The setup layer should not maintain a second, weaker copy of the runtime validation rules.

---

### 4.4 Optional Connectivity Tests

Where appropriate, the user may explicitly request active tests such as:

- Radio connection test.
- MQTT broker connection test.
- Local dashboard bind test.

Active tests should be clearly distinguished from static configuration validation because they may cause hardware or network side effects.

Failures should produce actionable messages such as:

```text
Unable to open COM5.

Possible causes:
- The radio is disconnected.
- Another application is currently using COM5.
- The selected serial port is incorrect.

Select another port or close the application currently using the device and try again.
```

rather than only exposing low-level runtime exceptions.

---

### 4.5 Standalone Doctor

The validation capability should also be usable outside the onboarding wizard.

Potential access methods may include:

- A button in the configuration interface.
- A command-line `doctor` or `config:check` command.
- A diagnostic mode invoked by the installer.

Exact command names should be selected during implementation planning.

---

## Scope 5: Automatic Service Setup & Lifecycle Management

### 5.1 Problem

A successful configuration is not enough if the user must manually start MeshCore Observer every time the computer reboots.

Persistent operation should be part of the normal setup experience.

---

### 5.2 User Stories

As an Observer operator, I want MeshCore Observer to start automatically when my computer starts so that the Observer remains available without manual intervention.

As a Windows user, I want setup to configure the appropriate Windows startup/service mechanism for me.

As a Linux user, I want setup to configure the appropriate system service mechanism for me.

As an operator, I want to see whether MeshCore Observer is currently running without needing to understand operating-system administration tools.

---

### 5.3 Windows

Windows should be treated as a first-class target.

The setup process should be able to configure a supported persistent execution mechanism.

The implementation should evaluate whether to:

- Extend the project's existing Windows Scheduled Task approach.
- Use a proper Windows Service mechanism.
- Use another lightweight native approach that does not create unnecessary dependency or packaging complexity.

The user should not need to manually create Scheduled Tasks or services.

---

### 5.4 Linux / Raspberry Pi

Linux installations should support an appropriate persistent service model.

For distributions using `systemd`, the setup process should be able to create and manage an appropriate unit where permitted.

The implementation should account for:

- Service user.
- Working directory.
- Configuration/data paths.
- Restart behavior.
- Startup dependencies.
- File permissions.
- Logs.
- Application upgrades.

Alternative service systems do not need to be supported in the first implementation unless explicitly included in the supported-platform matrix.

---

### 5.5 Service Status

The configuration experience should display basic service/runtime status where practical.

Potential information includes:

- Running / stopped.
- Startup mode enabled / disabled.
- Last known start time.
- Application version.
- Last startup failure where safely available.

Potential actions include:

- Start.
- Stop.
- Restart.
- Enable automatic startup.
- Disable automatic startup.

Operating-system permissions and safe shutdown behavior must be respected.

The configuration interface must not claim success until the requested lifecycle action has actually been accepted by the operating system.

---

## Scope 6: Safe Reconfiguration

### 6.1 Problem

Configuration changes should not require uninstalling and reinstalling MeshCore Observer.

Reconfiguration should be treated as a normal lifecycle activity.

---

### 6.2 User Stories

As an operator, I want to reopen the configuration interface later so that I can modify my Observer as my setup changes.

As an operator, I want to add or change an MQTT broker without reinstalling the application.

As an operator, I want to change radio connection settings without manually editing configuration files.

As an operator, I want to modify bot configuration through the same guided interface used during onboarding.

As an operator, I want to know whether a change requires a service restart.

---

### 6.3 Reconfiguration Flow

The reconfiguration experience should:

1. Load the current supported configuration.
2. Present it through the same guided UI model.
3. Allow changes.
4. Validate the complete proposed configuration.
5. Show meaningful validation errors without modifying the running configuration.
6. Summarize the proposed changes where useful.
7. Apply the new configuration safely.
8. Restart or reload the service where required.
9. Confirm that the new configuration was successfully accepted.
10. Preserve a recovery path if activation fails.

Users should not need to manually reconcile multiple configuration files.

---

## Scope 7: Safe Apply, Backup & Recovery

### 7.1 Problem

A configuration UI creates a risk of making configuration changes easier to perform but also easier to accidentally break.

The configuration system should therefore provide a safer application model than direct manual file editing.

---

### 7.2 Atomic Configuration Updates

Configuration files should not be replaced incrementally in a way that can leave the installation partially updated.

Where practical, applying configuration should follow a process similar to:

1. Construct candidate configuration.
2. Validate candidate configuration completely.
3. Write candidate files to temporary locations.
4. Ensure writes complete successfully.
5. Preserve the previous known-good configuration.
6. Atomically replace the active configuration.
7. Attempt required service activation/restart.
8. Record whether activation succeeded.

The exact atomic-write strategy may vary by operating system.

---

### 7.3 Known-Good Configuration

The system should maintain a reasonable recovery mechanism for the previous working configuration.

If newly applied configuration prevents the application from starting correctly, the user should have an understandable path to restore the previous configuration.

Automatic rollback may be appropriate in some scenarios, but should not be implemented until "successful activation" can be reliably defined.

---

### 7.4 Backup / Export

The user should be able to create a configuration backup for purposes such as:

- Moving to another machine.
- Reinstalling the operating system.
- Upgrading hardware.
- Recovering from accidental changes.

The backup design must explicitly define how secrets are handled.

Potential approaches include:

- Export non-secret configuration only.
- Export secret references but not secret values.
- Provide an explicitly protected/encrypted export mode in the future.

Plaintext secret export should not occur accidentally.

---

### 7.5 Restore / Import

Where practical, the configuration interface should support importing a previously exported configuration.

Imported configuration must pass the same current-version validation as manually entered configuration.

The importer should not blindly trust older configuration files.

If migration is required, the user should be told what changed.

---

## Scope 8: Advanced Configuration & Power Users

### 8.1 Problem

Simplifying setup should not reduce control for advanced operators.

Some users may already maintain configuration through scripts, source control, remote administration tooling, or manual file editing.

---

### 8.2 Advanced Mode

The guided interface should provide an advanced configuration mode where appropriate.

Advanced mode may expose:

- Less commonly used settings.
- Raw values not normally needed during onboarding.
- File locations.
- Service details.
- Diagnostic information.

The UI should clearly distinguish advanced options from normal required setup.

---

### 8.3 Existing Configuration Compatibility

Where practical, existing valid installations should be recognized rather than forcing users to migrate through onboarding from scratch.

The setup/configuration interface should be able to load existing supported configuration and represent it in the UI.

Manual configuration should remain possible for users who intentionally prefer it.

The guided setup system should not become the only supported path to a valid installation unless that decision is made separately.

---

## Scope 9: Setup UX & Accessibility

### 9.1 Progressive Disclosure

The normal first-run path should ask only the questions necessary to create a functioning Observer.

A conceptual flow might resemble:

```text
Welcome
   |
   v
Radio Connection
   |
   v
Observer Details
   |
   v
MQTT Brokers
   |
   v
Bots
   |
   v
Dashboard / Optional Features
   |
   v
Review
   |
   v
Validation
   |
   v
Install Service
   |
   v
Ready
```

Optional and advanced configuration should not interrupt the primary path unless required.

---

### 9.2 Plain Language

The interface should prefer user-facing terminology over internal implementation terminology.

For example, prefer:

```text
How is your MeshCore radio connected?
```

over:

```text
MESHCORE_CONNECTION_TYPE
```

The backend variable/configuration name may still be shown in advanced help where useful.

---

### 9.3 Contextual Help

Settings should provide concise explanations of:

- What the setting controls.
- Whether it is required.
- Recommended values where appropriate.
- Common mistakes.
- Whether changing it requires a restart.

Help content should be available inside the workflow rather than requiring the user to continuously reference external documentation.

---

### 9.4 Review Before Apply

Before initial activation or a significant reconfiguration, the user should see a readable summary.

For example:

```text
Radio
  Connection: Serial
  Device: COM5

MQTT
  2 brokers configured
  2 connectivity tests passed

Bots
  3 channel bots enabled

Dashboard
  Enabled
  Local port: 8080

Automatic startup
  Enabled

Configuration validation
  Passed
```

Secret values must not appear in this summary.

---

### 9.5 Accessibility

The setup interface should follow the same accessibility direction as the main dashboard.

At minimum:

- Keyboard-accessible controls.
- Proper field labels.
- Clear validation messages.
- Error summaries that identify the affected field.
- Logical focus movement.
- Sufficiently large click/touch targets.
- Responsive layouts.
- No reliance on color alone to communicate status.
- Clear progress indication.
- Avoid unnecessary technical jargon.

Given the intended audience, readability should be treated as a primary requirement rather than decorative polish.

---

## 10 Cross-Cutting Requirements

### 10.1 Existing Configuration Architecture

The setup system should sit on top of MeshCore Observer's existing configuration model wherever practical.

The UI may generate or modify backend configuration such as:

- Local environment configuration.
- Broker configuration.
- Bot configuration.
- Future supported application configuration.

Runtime feature modules should continue receiving validated configuration through the application's central configuration boundary.

The setup UI should not cause feature modules to begin reading configuration directly from web state or `process.env`.

---

### 10.2 Configuration Schema Reuse

The same rules that determine whether configuration is valid at normal runtime should be reused by:

- First-run setup.
- Reconfiguration.
- Configuration doctor.
- Import/restore.
- Final startup validation.

Avoid maintaining separate validation implementations that can drift apart.

---

### 10.3 Setup-State Storage

Incomplete onboarding state may need to be persisted so setup can be resumed.

Setup-state storage must:

- Be local.
- Have a defined lifecycle.
- Avoid storing secrets unnecessarily.
- Not be confused with active production configuration.
- Be removable after setup completes where appropriate.

A partially completed wizard must never accidentally become production configuration.

---

### 10.4 Secrets

Secret values require deliberate handling throughout installation and configuration.

Requirements include:

- Do not include secrets in logs.
- Do not expose stored secret values unnecessarily through APIs.
- Do not include secrets in ordinary configuration exports.
- Do not put secrets in URLs.
- Do not put secrets in browser-local persistence without an explicit security design.
- Apply appropriate local file permissions where supported.
- Preserve compatibility with existing secret-reference mechanisms where practical.

---

### 10.5 Local-First Administration

The initial v2.5.0 setup/configuration experience should be local-first.

By default:

```text
Browser -> localhost setup interface -> local configuration/service controls
```

not:

```text
Browser -> public Internet -> hosted account -> local Observer
```

A future remote-administration capability can be considered independently.

---

### 10.6 Privilege Boundaries

Installation and service configuration may require elevated operating-system privileges.

The implementation should minimize the amount of code executed with elevated privileges.

Where possible:

- Perform ordinary configuration as the normal user.
- Request elevation only for operations that actually require it.
- Clearly explain why elevated access is needed.
- Avoid running the entire Observer process as administrator/root solely because installation required elevated access.

---

### 10.7 Failure Behavior

Setup failures must leave the installation in a recoverable state.

A failure while:

- Writing configuration.
- Installing a service.
- Restarting the service.
- Testing connectivity.
- Importing configuration.
- Updating the application.

must not silently destroy the previously working configuration.

---

### 10.8 Logging & Diagnostics

Setup-related logging should be useful for troubleshooting while remaining safe to share.

Diagnostics should include useful context such as:

- Setup step.
- Platform.
- Application version.
- Validation category.
- Service-operation result.

Diagnostics must redact secrets.

The setup UI should prefer friendly error messages while still making technical diagnostics available for advanced troubleshooting.

---

### 10.9 Upgrade Compatibility

The setup/configuration architecture should anticipate application upgrades.

An upgrade should not require users to repeat onboarding unless a configuration migration genuinely requires new information.

Where configuration formats change:

- Migrations should be explicit.
- Existing valid configuration should be preserved where possible.
- The user should be informed if manual action is required.
- Backups should be created before destructive migration.

---

## 11 Acceptance Criteria

This pillar is complete when the approved child features collectively satisfy the following.

### 11.1 Installation

- A supported Windows user can install MeshCore Observer without manually cloning the repository.
- A supported Linux/Raspberry Pi user has a documented guided installation path.
- Normal installation does not require manually creating configuration files from examples.
- Application data/configuration is separated from replaceable application code where practical.
- Installation failures provide actionable guidance.
- The installer provides a clear path into onboarding.

### 11.2 First-Run Onboarding

- A newly installed Observer can enter setup mode without a complete runtime configuration.
- Setup mode presents a local web-based onboarding interface.
- The setup UI is bound locally by default.
- A user can configure the required radio settings through the UI.
- A user can configure MQTT brokers through the UI.
- A user can configure supported bots through the UI.
- A user can configure supported general Observer settings through the UI.
- Advanced settings do not overwhelm the default onboarding path.
- Setup can be resumed after an intentional interruption where supported.
- Secret values are handled safely.

### 11.3 Validation

- Proposed configuration is validated before it becomes active.
- Validation uses the application's authoritative configuration rules wherever practical.
- Invalid configuration does not replace known-working active configuration.
- Errors identify the affected setting and provide understandable corrective guidance.
- Active hardware/network tests are distinguishable from static validation.
- A configuration-doctor capability can be invoked after onboarding.

### 11.4 Service Setup

- A supported Windows installation can be configured to start automatically without requiring the user to manually create the underlying startup mechanism.
- A supported Linux/Raspberry Pi installation can be configured to start automatically using the supported service mechanism.
- Service status can be determined from the setup/configuration experience or an associated management command.
- Start/restart behavior reports actual success or failure.
- Normal Observer execution does not unnecessarily require administrator/root privileges.

### 11.5 Reconfiguration

- An existing installation can reopen the configuration interface.
- Current supported configuration is loaded into the interface.
- Radio settings can be changed without reinstalling MeshCore Observer.
- MQTT broker configuration can be changed without reinstalling.
- Bot configuration can be changed without reinstalling.
- Other supported application settings can be changed without reinstalling.
- Proposed changes are validated before activation.
- The user is told when a restart is required.
- Application upgrades do not normally overwrite user configuration.

### 11.6 Recovery

- The previous known-good configuration is preserved before risky replacement.
- Partial configuration writes cannot leave active configuration in a mixed state.
- A failed apply operation provides a recovery path.
- Configuration can be backed up/exported without unintentionally exposing secrets.
- Supported configuration backups can be restored/imported and revalidated.

### 11.7 User Experience

- Normal setup does not require understanding environment variable names.
- Normal setup does not require editing JSON.
- User-facing configuration uses plain-language descriptions.
- Safe recommended defaults are provided where appropriate.
- Advanced configuration remains accessible.
- Setup is keyboard accessible.
- Validation and error states are clear and readable.
- The interface works across reasonable desktop and smaller-screen layouts.

### 11.8 Quality

- Setup configuration APIs validate inbound structured data.
- Secret values are redacted from logs and diagnostics.
- Platform-specific installer/service behavior has automated testing where practical.
- Configuration write/rollback behavior is tested.
- Existing manually configured installations remain supported unless an explicit migration is approved.
- Full test and lint workflows pass.
- Documentation covers installation, onboarding, reconfiguration, backup/recovery, service behavior, and troubleshooting.

---

## 12 Suggested Child Features

This feature request should be implemented through separate child issues rather than as one large change.

Recommended breakdown:

1. **Setup Architecture & Local Setup Mode**
2. **Configuration Schema Reuse / Setup Validation API**
3. **Web-Based First-Run Onboarding UI**
4. **Guided Radio Configuration & Connection Test**
5. **Guided MQTT Broker Configuration**
6. **Guided Bot & General Observer Configuration**
7. **Windows Installer / Setup Entry Point**
8. **Windows Automatic Startup / Service Integration**
9. **Linux / Raspberry Pi Installer**
10. **Linux Service Integration**
11. **Configuration Doctor / Preflight Diagnostics**
12. **Safe Configuration Apply & Known-Good Rollback**
13. **Configuration Backup / Export / Restore**
14. **Existing Installation Reconfiguration**
15. **Service Status & Lifecycle Controls**
16. **Setup UX / Accessibility / Plain-Language Review**
17. **Upgrade & Configuration Preservation Validation**
18. **Installation / Reconfiguration Documentation**

Some of these may be combined after architecture and packaging research clarifies the implementation boundaries.

---

## 13 Open Questions

These should be resolved during feature planning rather than guessed during implementation.

### 13.1 Packaging & Installation

- What should the primary Windows distribution artifact be?
- Should Windows users receive an installer, a self-contained setup script, a packaged archive with launcher, or another format?
- Should MeshCore Observer bundle/manage its own Node.js runtime or require the user to install a supported Node.js version?
- How should application upgrades be distributed?
- Where should application code, configuration, metrics, and logs live on Windows?
- Where should those files live on Linux?
- Which Windows versions should be officially supported?
- Which Linux distributions/architectures should be officially supported?
- Which Raspberry Pi models/architectures should be part of the supported matrix?

### 13.2 Setup Mode

- What command or launcher starts setup mode?
- Should setup mode automatically open the browser?
- What should happen when no valid configuration exists during normal startup?
- Should normal startup automatically offer setup mode, or should setup remain an explicit action?
- How should incomplete onboarding state be persisted?
- How long should incomplete setup state remain?
- Should setup mode stop automatically after successful configuration?

### 13.3 Configuration UI

- Which settings belong in the default onboarding path?
- Which settings belong in advanced mode?
- Should the UI render directly from shared schema/configuration metadata or use manually maintained forms?
- How should existing configuration comments or manually customized values be preserved?
- What happens when an existing configuration contains a valid advanced value the UI does not understand?
- Should raw configuration preview/editing be available in advanced mode?

### 13.4 Radio Discovery

- Can serial devices be safely enumerated on each supported platform without additional dependencies?
- Can candidate MeshCore radios be distinguished from unrelated serial devices?
- What information can be safely collected during a radio connection test?
- How should TCP-connected radios be tested without starting the full Observer?

### 13.5 Service Management

- Should Windows continue using Scheduled Tasks or move to a Windows Service implementation?
- Can a Windows Service be implemented without introducing an undesirable runtime dependency?
- What restart policy should be used after crashes?
- What service user should be used on Linux?
- Should Linux installations run as a dedicated `meshcore-observer` user?
- Which lifecycle actions should the web interface be allowed to perform?
- How should the configuration server restart the Observer without creating circular service-management behavior?
- Should the setup interface remain available while the normal service is running, or be launched only on demand?

### 13.6 Safe Apply & Rollback

- What constitutes successful activation of a new configuration?
- Is successful schema validation sufficient, or must the process remain healthy for a defined period?
- Should failure to connect to a radio automatically trigger rollback if the user intentionally saved an offline configuration?
- How many historical configuration revisions should be retained?
- Should rollback be automatic, user initiated, or both depending on failure type?
- How should configuration changes spanning multiple backend files be committed atomically?

### 13.7 Backup & Restore

- Which files constitute a portable Observer configuration backup?
- Should metrics/history be exportable separately from configuration?
- Should secret values ever be included in a backup?
- If secrets are excluded, how should the restore workflow tell the user which credentials must be re-entered?
- Should backups include application-version/configuration-schema metadata?
- How should older backups be migrated during import?

### 13.8 Security

- Does the local setup interface require a one-time setup token even when bound only to loopback?
- How should protection work if multiple local operating-system users can access the machine?
- How should configuration files containing secret values be permissioned on Windows and Linux?
- Should sensitive fields ever return their existing values to the browser, or should they display only "configured" state?
- How should service-control operations authorize requests from the local setup UI?

### 13.9 Reconfiguration

- Which configuration changes can eventually be applied without restarting the Observer?
- Which changes must always restart the service?
- Should v2.5.0 support live reload, or should validated restart remain the simpler and safer initial model?
- Should the interface provide a configuration-change history?
- Should users be able to intentionally revert to an earlier known-good configuration from the UI?

### 13.10 Upgrades

- Should application update management be part of v2.5.0 or should this pillar only ensure that future updates do not destroy configuration?
- If an update is available, should the configuration interface merely report it or eventually install it?
- How should configuration schema migrations interact with application rollback?
- Should an upgrade automatically create a configuration backup first?

---

## 14 Release Intent

This pillar should make MeshCore Observer substantially easier to adopt and operate by answering four practical questions for a user.

### 14.1 Can I install it without being a software developer?

A Windows, Linux, or Raspberry Pi user should have a clear installation path that does not assume familiarity with Git, npm, JSON, environment variables, or service administration.

### 14.2 Can I configure it without manually editing files?

The user should be able to configure the Observer through a guided local web experience that explains settings, validates them, and safely creates the backend configuration required by the application.

### 14.3 Will it keep running after I close the terminal or reboot the machine?

Setup should configure the appropriate persistent operating-system execution mechanism so the Observer behaves like an installed service rather than a command the user must remember to launch.

### 14.4 Can I change it later without starting over?

Configuration should be a normal ongoing workflow. Users should be able to reopen the configuration experience, modify settings, validate changes, apply them safely, and recover from bad changes without uninstalling or rebuilding the entire application.

Together, these capabilities should make MeshCore Observer feel less like a Node.js project that must be administered and more like a purpose-built MeshCore appliance that happens to run on the user's existing computer.

The guiding principle for this pillar is:

> **A user should be able to install, configure, run, diagnose, and later reconfigure MeshCore Observer without manually editing configuration files or understanding operating-system service management.**

The implementation should achieve that simplicity at the user-experience layer while preserving the strict validation, explicit configuration, predictable startup behavior, and maintainable architecture already established inside MeshCore Observer.
