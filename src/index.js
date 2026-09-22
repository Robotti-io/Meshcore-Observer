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
import { ServiceHealth } from './health/service-health.js';
import { MetricsServer } from './web/metrics-server.js';
import packageInfo from '../package.json' with { type: 'json' };

// src/metrics/store.js is imported dynamically, only when the metrics UI is
// enabled (see below) - it statically imports node:sqlite, which requires
// Node >=22.13.0 (see docs/plans/feat-improved_metrics_reporting.md). A
// dynamic import lets a too-old runtime fail with a clear, caught warning
// that just disables the metrics UI, rather than crashing every startup
// (including ones that never touch the metrics UI at all) with a raw
// ERR_UNKNOWN_BUILTIN_MODULE from a top-level import.

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
  const replyQueue = new ReplyQueue({
    quietMs: config.botReplyQueue.quietMs,
    ttlMs: config.botReplyQueue.ttlMs,
    logger,
    dispatch: createReplyDispatcher(botsByName)
  });

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
  // logical MeshCore channel it's on - feeds the reply queue's quiet-
  // window detection (see reply-queue.js).
  radioManager.on('radio.packet', () => replyQueue.noteActivity());

  packetPipeline.on('packet', (packet) => {
    observerPublisher.publishPacket(packet).catch((err) => {
      logger.warn('services.mqtt', 'failed to publish packet', { error: err.message });
    });
  });

  // Constructed before the bots below (rather than alongside the rest of
  // the metrics UI further down) so each ChannelBot can be given a
  // recordBotCommand hook at construction time.
  let metricsStore = null;
  if (config.metricsUi.enabled) {
    try {
      const { MetricsStore } = await import('./metrics/store.js');
      metricsStore = new MetricsStore({ dbPath: config.metricsUi.dbPath });
    } catch (err) {
      logger.warn(
        'services.metricsUi',
        'metrics UI disabled: could not open the persisted metrics store (node:sqlite requires Node >=22.13.0)',
        { nodeVersion: process.version, dbPath: config.metricsUi.dbPath, error: err.message }
      );
    }
  }

  const bots = config.bots.map((botConfig) => {
    const bot = new ChannelBot({
      radioManager,
      botConfig,
      logger,
      recordBotCommand: metricsStore
        ? (botName, trigger, occurredAt) => metricsStore.recordBotCommand({ botName, trigger, occurredAt })
        : undefined,
      replyQueue
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
  const healthLogTimer = setInterval(() => {
    logger.info('app.health', 'health snapshot', serviceHealth.snapshot());
  }, HEALTH_LOG_INTERVAL_MS);
  healthLogTimer.unref();

  let metricsServer = null;
  if (metricsStore) {
    metricsServer = new MetricsServer({
      serviceHealth,
      metricsStore,
      botsConfig: config.bots,
      host: config.metricsUi.host,
      port: config.metricsUi.port,
      sampleIntervalMs: config.metricsUi.sampleIntervalMs,
      maxChartBuckets: config.metricsUi.maxChartBuckets,
      retentionDays: config.metricsUi.retentionDays,
      logger
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

    clearInterval(healthLogTimer);
    for (const stop of stopTokenRefreshLoops) {
      stop();
    }
    if (metricsServer) {
      await metricsServer.stop();
    }
    if (metricsStore) {
      metricsStore.close();
    }

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
