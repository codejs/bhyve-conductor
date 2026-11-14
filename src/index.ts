/**
 * Soil-moisture driven watering: polls the Tuya soil sensors and starts a supplemental B-hyve run
 * for any zone that's too dry. With LOCATION set, the amount comes from the weather forecast and the
 * existing B-hyve schedule (see conductor/water-budget.ts).
 *   npm start                   run continuously
 *   npm run dev -- --dry-run    log decisions without sending commands
 *   npm run conductor:check     one dry-run cycle, then exit (good for checking the config)
 *   npm run audit               review what happened (watering, outages, recoveries)
 *
 * Everything is kept in one SQLite database (CONDUCTOR_DB): watering history and schedule, pending cycles,
 * alerts and the audit trail. See docs/sqlite-storage.md.
 */
import { parseArgs } from 'node:util';
import { teeAudit, type AuditSink } from './audit/audit.ts';
import { BhyveClient } from './bhyve/client.ts';
import { assertForecastReady, loadConductorConfig } from './conductor/config.ts';
import { WateringHistory } from './conductor/history.ts';
import { Monitor } from './conductor/monitor.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/database.ts';
import { importLegacyFiles } from './db/legacy-import.ts';
import { beginSession } from './db/session.ts';
import { log } from './log.ts';
import { TuyaSoilSource } from './sensors/tuya-soil.ts';
import { DeliveryQueue } from './notify/queue.ts';
import { Notifier } from './notify/notifier.ts';
import { TelegramClient } from './notify/telegram.ts';
import { TuyaClient } from './tuya/client.ts';
import { parseLocation, resolveLocation } from './weather/location.ts';
import { geocodeUS, OpenMeteoWeather } from './weather/open-meteo.ts';
import type { WeatherProvider } from './weather/types.ts';

/** How long to keep the socket open after a one-shot command so it is flushed before closing. */
const SEND_GRACE_MS = 3_000;

const main = async (): Promise<void> => {
  const { values: args } = parseArgs({
    options: { once: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } },
  });

  const env = loadConfig([
    'BHYVE_EMAIL',
    'BHYVE_PASSWORD',
    'TUYA_CLIENT_ID',
    'TUYA_CLIENT_SECRET',
    'TUYA_BASE_URL',
    'TUYA_MOISTURE_CODE',
    'CONDUCTOR_CONFIG',
    'CONDUCTOR_STATE',
    'CONDUCTOR_AUDIT',
    'CONDUCTOR_DB',
    'LOCATION',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
  ]);
  const config = await loadConductorConfig(env.CONDUCTOR_CONFIG);
  if (args['dry-run']) config.dryRun = true;

  // Creates or upgrades the database (backing it up first; a database of the drizzle-based version is
  // converted once), and on the first run imports the files an earlier version kept. A dry run leaves those
  // alone: it must not change what the real service sees.
  const db = openDatabase(env.CONDUCTOR_DB);
  const legacy = config.dryRun
    ? undefined
    : await importLegacyFiles(db, { statePath: env.CONDUCTOR_STATE, auditPath: env.CONDUCTOR_AUDIT }, config.zones, new Date());
  const session = await beginSession(db, {
    config,
    mode: args.once ? 'once' : 'continuous',
    now: () => new Date(),
    pid: process.pid,
    ...(legacy?.lastAuditEvent ? { legacyLastEvent: legacy.lastAuditEvent } : {}),
  });

  const auditDb = session.audit;
  let audit: AuditSink = auditDb;
  let notifier: Notifier | undefined;
  let queue: DeliveryQueue | undefined;
  if (Boolean(env.TELEGRAM_BOT_TOKEN) !== Boolean(env.TELEGRAM_CHAT_ID)) {
    throw new Error('Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for notifications (or neither)');
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    if (config.dryRun) {
      log.info('Dry run: Telegram notifications are off');
    } else {
      const telegram = new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });
      // Delivery failures go to the audit trail only (not back through the notifier).
      queue = new DeliveryQueue(telegram, {}, (drop) =>
        auditDb.record('notification.failed', { error: drop.error, attempts: drop.attempts, message: drop.text.slice(0, 200) }),
      );
      const q = queue;
      notifier = new Notifier({ options: config.notifications, deliver: (n) => q.enqueue(n.text) });
      audit = teeAudit(auditDb, notifier);
      log.info(`Telegram notifications on (${config.notifications.minSeverity} and above)`);
    }
  }
  if (db.transferred) {
    const { backupPath, rows, drizzleMigrations } = db.transferred;
    audit.record('storage.transferred', { from: 'drizzle', backup: backupPath, rows, drizzleMigrations });
  }
  if (legacy) {
    audit.record('storage.imported', {
      runs: legacy.runs,
      sequences: legacy.sequences,
      alerts: legacy.alerts,
      auditEvents: legacy.auditEvents,
      skipped: legacy.skipped,
      files: legacy.renamed,
    });
  }
  if (session.unclean) {
    const { lastEvent, lastEventAt } = session.unclean;
    log.warn(`The previous run did not shut down cleanly (last audit event: ${lastEvent} at ${lastEventAt})`);
    audit.record('service.unclean_shutdown', { lastEvent, lastEventAt });
  }
  audit.record('service.started', { mode: args.once ? 'once' : 'continuous', dryRun: config.dryRun, zones: config.zones.length });

  let weather: WeatherProvider | undefined;
  if (env.LOCATION) {
    assertForecastReady(config);
    const point = await resolveLocation(parseLocation(env.LOCATION), geocodeUS);
    log.info(
      `Forecast location: ${point.name ?? env.LOCATION} (${point.latitude}, ${point.longitude}); ` +
        `looking ${config.forecastHours}h ahead`,
    );
    weather = new OpenMeteoWeather(point);
  } else {
    log.info('LOCATION is not set: dry zones get their fixed runMinutes (no forecast)');
  }

  const tuya = new TuyaClient({ clientId: env.TUYA_CLIENT_ID, clientSecret: env.TUYA_CLIENT_SECRET, baseUrl: env.TUYA_BASE_URL });
  const source = new TuyaSoilSource(tuya, {
    sensorIds: [...new Set(config.zones.flatMap((z) => z.sensorIds))],
    moistureCode: env.TUYA_MOISTURE_CODE,
  });
  const bhyve = new BhyveClient({ email: env.BHYVE_EMAIL, password: env.BHYVE_PASSWORD });
  bhyve.onConnection((state, { code }) =>
    audit.record(state === 'connected' ? 'socket.connected' : 'socket.disconnected', code === undefined ? {} : { code }),
  );

  const { state } = session;
  const monitor = new Monitor({
    config,
    source,
    bhyve,
    history: new WateringHistory(state.history),
    pendingSequences: state.sequences,
    alertState: state.alerts,
    zoneSpells: state.zoneSpells,
    store: session.store,
    heartbeat: session.heartbeat,
    audit,
    ...(weather ? { weather } : {}),
  });

  const finish = async (reason: string): Promise<void> => {
    await monitor.stop();
    bhyve.close();
    audit.record('service.stopped', { reason });
    await session.end(reason);
    notifier?.stop();
    // Give queued notifications a moment, but never let Telegram hold up a shutdown.
    if (queue) await Promise.race([queue.flush(), new Promise((r) => setTimeout(r, 10_000))]);
    queue?.stop(); // drops are audited, so the database closes after this
    await auditDb.flush();
    await db.close();
  };

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received; stopping (unfinished watering sequences are saved and resume on the next start)`);
    void finish(signal).finally(() => process.exit(process.exitCode ?? 0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (args.once) {
    await monitor.resumePending();
    const result = await monitor.runCycle();
    if (!config.dryRun) {
      log.info('Waiting for any watering sequences to finish (Ctrl+C pauses them; they resume on the next start)');
      await monitor.drain();
    }
    if (result.sent.length > 0 && !config.dryRun) await new Promise((r) => setTimeout(r, SEND_GRACE_MS));
    if (stopping) return;
    stopping = true;
    await finish('once');
    if (result.failed.length > 0) process.exitCode = 1;
    process.exit();
  }

  monitor.start();
};

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
