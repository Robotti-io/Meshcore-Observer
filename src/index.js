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
import { ServiceHealth } from './health/service-health.js';
import packageInfo from '../package.json' with { type: 'json' };

const SHUTDOWN_TIMEOUT_MS = 10000;
const HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;

function main() {
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

  packetPipeline.on('packet', (packet) => {
    observerPublisher.publishPacket(packet).catch((err) => {
      logger.warn('services.mqtt', 'failed to publish packet', { error: err.message });
    });
  });

  const bots = config.bots.map((botConfig) => ({
    name: botConfig.name,
    enabled: botConfig.enabled,
    bot: new ChannelBot({ radioManager, botConfig, logger })
  }));
  for (const { bot } of bots) {
    bot.start();
  }

  const serviceHealth = new ServiceHealth({
    radioManager,
    mqttManager,
    packetPipeline,
    bots
  });
  const healthLogTimer = setInterval(() => {
    logger.info('app.health', 'health snapshot', serviceHealth.snapshot());
  }, HEALTH_LOG_INTERVAL_MS);
  healthLogTimer.unref();

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
