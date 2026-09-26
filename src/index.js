import { loadConfig } from './config/index.js';
import { createLogger } from './logging/logger.js';
import { RadioManager } from './radio/radio-manager.js';
import { PacketPipeline } from './packets/packet-pipeline.js';
import { MqttManager } from './mqtt/mqtt-manager.js';
import { ObserverPublisher } from './mqtt/observer-publisher.js';
import { buildObserverStatusPayload } from './mqtt/observer-status.js';
import { resolveTopic, STATUS_TOPIC_TEMPLATE } from './mqtt/topic-resolver.js';
import { LetsMeshAuth } from './mqtt/letsmesh-auth.js';
import { startTokenRefreshLoop } from './mqtt/token-refresh-loop.js';
import { ChannelBot } from './bots/channel-bot.js';
import { ReplyQueue } from './bots/reply-queue.js';
import { createReplyDispatcher } from './bots/reply-dispatcher.js';
import { AirtimeCoordinator } from './radio/airtime-coordinator.js';
import { FloodAdvertScheduler } from './radio/flood-advert-scheduler.js';
import { NodeRegistry } from './nodes/node-registry.js';
import { ServiceHealth } from './health/service-health.js';
import { MetricsServer } from './web/metrics-server.js';
import { MetricsSampler } from './metrics/sampler.js';
import packageInfo from '../package.json' with { type: 'json' };

// src/metrics/store.js is imported dynamically - it statically imports
// node:sqlite, which requires Node >=22.13.0. package.json's own `engines`
// field already declares that as this project's minimum, but a dynamic
// import here lets startup fail with one clear, specific error message
// (see below) rather than a raw ERR_UNKNOWN_BUILTIN_MODULE from a
// top-level import the moment an operator runs this on an older Node.
//
// The persisted store this opens is a *core* observer capability, not a
// side effect of the optional HTTP dashboard: every feature that used to
// keep its own in-memory state (the node/repeater registry backing
// `!lookup`, bot reply-lifecycle counters) now reads and writes through it
// unconditionally, regardless of whether PACKETCAPTURE_METRICS_UI_ENABLED
// is set - that flag only controls whether the HTTP dashboard itself is
// served. A store that fails to open is therefore a startup-blocking
// failure, the same as an invalid configuration value, not a
// warn-and-degrade one.

const SHUTDOWN_TIMEOUT_MS = 10000;
const HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Logging is not yet initialized; configuration errors must be visible
    // before any hardware or network side effects occur.
    console.error(`Configuration error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logging);

  logger.info('app.bootstrap', 'meshcore-observer starting', {
    iata: config.observer.iata,
    radioType: config.radio.type,
    brokerCount: config.brokers.length,
    botCount: config.bots.length
  });

  // Constructed early (before hardware/network side effects, and before the
  // reply queue/node registry below, both of which now depend on it
  // directly) - see the import comment above for why a failure here is
  // fatal rather than a degrade-and-continue warning.
  let metricsStore;
  try {
    const { MetricsStore } = await import('./metrics/store.js');
    metricsStore = new MetricsStore({ dbPath: config.metricsUi.dbPath });
  } catch (err) {
    logger.error(
      'services.metricsUi',
      'failed to open the persisted data store - Node >=22.13.0 with node:sqlite support is now a hard requirement for this observer (see README\'s Requirements section)',
      { nodeVersion: process.version, dbPath: config.metricsUi.dbPath, error: err.message }
    );
    process.exitCode = 1;
    return;
  }

  const radioManager = new RadioManager({ config, logger });

  const packetPipeline = new PacketPipeline({
    logger,
    getObserverIdentity: () => {
      const deviceInfo = radioManager.getDeviceInfo();
      return deviceInfo ? { origin: deviceInfo.name, originId: deviceInfo.publicKey } : null;
    }
  });

  // One shared queue across every configured bot - "the local frequency"
  // is one physical radio, so FIFO ordering and quiet-window detection
  // only make sense as a single resource, not per-bot state. See
  // reply-queue.js and README's "Channel bots" section. `botsByName` is
  // populated below as each bot is constructed; createReplyDispatcher()
  // only reads from it later (once a quiet window is actually observed),
  // so the empty map here at construction time is fine.
  const botsByName = new Map();
  const nodeRegistry = new NodeRegistry({ logger, store: metricsStore });
  const airtimeCoordinator = new AirtimeCoordinator({ quietMs: config.botReplyQueue.quietMs });
  const replyQueue = new ReplyQueue({
    ttlMs: config.botReplyQueue.ttlMs,
    logger,
    dispatch: createReplyDispatcher(botsByName),
    store: metricsStore,
    airtimeCoordinator
  });
  // Resumes any reply still pending from a previous process (see
  // reply-queue.js's class doc comment and AGENTS.md's "Persistence"
  // section) - a no-op if nothing was left queued, the common case.
  replyQueue.start();

  const floodAdvertScheduler = new FloodAdvertScheduler({
    radioManager,
    airtimeCoordinator,
    store: metricsStore,
    logger,
    intervalHours: config.floodAdvert.intervalHours
  });
  floodAdvertScheduler.start();

  // LetsMesh-style (token auth) brokers get a dedicated on-device-signed
  // JWT auth seam, kept separate from generic MQTT connection code per
  // docs/project_plan.spec.md Section 20.
  const letsMeshAuthByBrokerId = new Map();
  for (const brokerConfig of config.brokers) {
    if (brokerConfig.auth.method === 'token') {
      letsMeshAuthByBrokerId.set(
        brokerConfig.id,
        new LetsMeshAuth({
          radioManager,
          audience: brokerConfig.auth.audience,
          ttlSeconds: brokerConfig.auth.tokenTtlSeconds ?? undefined,
          email: config.observer.ownerEmail,
          client: `meshcore-observer/${packageInfo.version}`,
          logger
        })
      );
    }
  }

  const mqttManager = new MqttManager({
    config,
    logger,
    getCredentialHooks: (brokerConfig) => {
      const auth = letsMeshAuthByBrokerId.get(brokerConfig.id);
      if (!auth) {
        return {};
      }
      return {
        getUsername: () => `v1_${radioManager.getDeviceInfo().publicKey.toUpperCase()}`,
        getPassword: () => auth.refreshIfNeeded()
      };
    }
  });
  const observerPublisher = new ObserverPublisher({
    mqttManager,
    iata: config.observer.iata,
    clientVersion: packageInfo.version
  });

  let mqttStarted = false;
  const stopTokenRefreshLoops = [];

  radioManager.on('radio.connected', (deviceInfo) => {
    logger.info('app.bootstrap', 'radio ready', { publicKey: deviceInfo.publicKey, name: deviceInfo.name });

    if (!mqttStarted) {
      mqttStarted = true;
      const offlinePayload = buildObserverStatusPayload({
        deviceInfo,
        clientVersion: packageInfo.version,
        status: 'offline'
      });
      const will = {
        topic: resolveTopic(STATUS_TOPIC_TEMPLATE, {
          IATA: config.observer.iata,
          PUBLIC_KEY: deviceInfo.publicKey.toUpperCase()
        }),
        payload: JSON.stringify(offlinePayload)
      };
      mqttManager.on('broker.connected', () => {
        observerPublisher.publishStatus(deviceInfo, 'online').catch((err) => {
          logger.warn('services.mqtt', 'failed to publish observer status', { error: err.message });
        });
      });
      mqttManager.connectAll(will);

      for (const [brokerId, auth] of letsMeshAuthByBrokerId) {
        stopTokenRefreshLoops.push(
          startTokenRefreshLoop({ auth, broker: mqttManager.getBroker(brokerId), will, logger })
        );
      }
    }
  });
  radioManager.on('radio.disconnected', () => {
    logger.warn('app.bootstrap', 'radio connection lost, reconnecting');
  });
  radioManager.on('radio.error', (detail) => {
    logger.warn('app.bootstrap', 'radio error', detail);
  });
  radioManager.on('radio.packet', (rawPush) => packetPipeline.handleRawPacket(rawPush));
  // Any heard RF packet occupies the shared channel, regardless of which
  // logical MeshCore channel it's on. Replies and scheduled adverts share
  // this quiet-window clock and outbound reservation.
  radioManager.on('radio.packet', () => replyQueue.noteActivity());

  const bots = config.bots.map((botConfig) => {
    const bot = new ChannelBot({
      radioManager,
      botConfig,
      logger,
      replyQueue,
      nodeRegistry,
      repeatCheckTimeoutMs: config.botReplyQueue.repeatCheckTimeoutMs
    });
    botsByName.set(botConfig.name, bot);
    return { name: botConfig.name, enabled: botConfig.enabled, bot };
  });
  for (const { bot } of bots) {
    bot.start();
  }

  const serviceHealth = new ServiceHealth({
    radioManager,
    mqttManager,
    packetPipeline,
    bots,
    replyQueue
  });

  // Fed the actual per-broker outcome of every publish attempt (see
  // MqttManager#publish), rather than serviceHealth inferring "published"
  // from the packet pipeline alone (docs/Code Review - 2026-09-22.md item 4:
  // entering the pipeline is not the same as reaching a broker).
  packetPipeline.on('packet', (packet) => {
    observerPublisher
      .publishPacket(packet)
      .then((results) => serviceHealth.recordPublishResults(results))
      .catch((err) => {
        logger.warn('services.mqtt', 'failed to publish packet', { error: err.message });
      });
  });
  // Independent of the MQTT-publish listener above: an ADVERT with a
  // verified signature and a name updates the node registry that
  // ChannelBot's `!lookup`-kind commands read from (see
  // docs/plans/feat-bot_command_to_lookup_repeater_name.md). Fire-and-
  // forget with a caught/logged rejection, matching the publish listener's
  // own pattern - a registry failure must never affect packet capture/MQTT.
  packetPipeline.on('packet', (packet) => {
    nodeRegistry.recordFromDecodedPacket(packet).catch((err) => {
      logger.warn('services.nodeRegistry', 'failed to process a possible advert', { error: err.message });
    });
  });

  const healthLogTimer = setInterval(() => {
    logger.info('app.health', 'health snapshot', serviceHealth.snapshot());
  }, HEALTH_LOG_INTERVAL_MS);
  healthLogTimer.unref();

  // Unconditional - see the import comment near the top of this file:
  // persisted metrics/state are a core capability now, independent of
  // whether the HTTP dashboard below is enabled.
  const metricsSampler = new MetricsSampler({
    serviceHealth,
    metricsStore,
    sampleIntervalMs: config.metricsUi.sampleIntervalMs,
    retentionDays: config.metricsUi.retentionDays,
    logger
  });
  metricsSampler.start();

  let metricsServer = null;
  if (config.metricsUi.enabled) {
    metricsServer = new MetricsServer({
      serviceHealth,
      metricsStore,
      botsConfig: config.bots,
      host: config.metricsUi.host,
      port: config.metricsUi.port,
      sampleIntervalMs: config.metricsUi.sampleIntervalMs,
      maxChartBuckets: config.metricsUi.maxChartBuckets,
      logger,
      sampler: metricsSampler
    });
    metricsServer.start().catch((err) => {
      logger.warn('services.metricsUi', 'failed to start metrics UI', { error: err.message });
    });
  }

  radioManager.start();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('app.bootstrap', 'shutdown signal received', { signal });

    const timeout = setTimeout(() => {
      logger.warn('app.bootstrap', 'shutdown exceeded bounded duration, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    // Stop accepting bot work first (docs/project_plan.spec.md Section 22):
    // unsubscribe every bot from radio events so no new trigger can be
    // matched, then stop both outbound schedulers so queued work cannot
    // start while MQTT/radio are closing below.
    for (const { bot } of bots) {
      bot.stop();
    }
    await floodAdvertScheduler.stop();
    await replyQueue.stop();

    clearInterval(healthLogTimer);
    for (const stop of stopTokenRefreshLoops) {
      stop();
    }
    if (metricsServer) {
      await metricsServer.stop();
    }
    metricsSampler.stop();
    metricsStore.close();

    const deviceInfo = radioManager.getDeviceInfo();
    if (deviceInfo && mqttManager.hasAnyConnected()) {
      await observerPublisher.publishStatus(deviceInfo, 'offline').catch((err) => {
        logger.warn('services.mqtt', 'failed to publish offline status', { error: err.message });
      });
    }

    await mqttManager.closeAll();
    await radioManager.stop();

    clearTimeout(timeout);
    logger.info('app.bootstrap', 'meshcore-observer stopped');
    process.exitCode = 0;
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main();
