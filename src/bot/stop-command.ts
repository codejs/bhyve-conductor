import type { BhyveDevice } from '../bhyve/types.ts';
import type { ConductorStatus, StopResult } from '../conductor/monitor.ts';
import { act, confirm, done, via, type RunResult, type SafetyCommand } from './conversation.ts';
import { fitLines, safe, shortTime } from './format.ts';
import { findZone, NOT_A_ZONE, zoneList, type ZoneRef } from './zones.ts';

/**
 * /stop [zone]: turn the water off now, on every controller of the conductor's zones or on one zone's
 * controller, and cancel the conductor's watering there (in progress or on hold). A safety command: it asks
 * to confirm, but not for the passphrase, and it works while changes are locked. It is given nothing that
 * could start watering: B-hyve's device list (a read) and the monitor's stopWatering.
 */

export interface WaterStop {
  /** The zones, with their controller. */
  zones(): (ZoneRef & { deviceId: string })[];
  status(): ConductorStatus;
  /** B-hyve's view of the controllers (a read), to say what's on. */
  devices(): Promise<BhyveDevice[]>;
  stopWatering(deviceIds: readonly string[], by: string): Promise<StopResult[]>;
}

export const buildStopCommand = (deps: { stop: WaterStop; timeZone?: string | undefined }): SafetyCommand => ({
  kind: 'safety',
  name: 'stop',
  description: 'Turn the water off now (asks you to confirm)',
  help: {
    usage: [
      { call: '/stop', does: "turns the water off on all the conductor's controllers" },
      { call: '/stop 2', does: "only zone 2's controller (number as in /health, or the zone's name)" },
    ],
    details: [
      "It shows what is on, asks you to confirm (reply yes), then stops the water and cancels the conductor's watering there.",
      'A B-hyve controller waters one zone at a time, so stopping a zone stops its whole controller, including a run from your B-hyve schedule.',
      'The controllers go back to their normal schedule. Automatic watering stays on: /pause keeps it from starting again.',
    ],
  },
  acceptsArgs: true,
  begin: async (actor, args) => {
    const zones = deps.stop.zones();
    if (zones.length === 0) return done('No zones are configured.');
    const arg = args.trim().toLowerCase();
    let targets: string[];
    if (arg === '' || arg === 'all') {
      targets = [...new Set(zones.map((z) => z.deviceId))];
    } else {
      const zone = findZone(args, zones);
      if (!zone) return done([`⚠️ ${NOT_A_ZONE} Send /stop for all of them, or one of:`, ...zoneList(zones)].join('\n'));
      targets = [zone.deviceId];
    }

    // What is on: B-hyve's view (it may be unreachable: the stop is still offered) and the conductor's own.
    let devices: BhyveDevice[] | undefined;
    try {
      devices = await deps.stop.devices();
    } catch {
      devices = undefined;
    }
    const s = deps.stop.status();
    const at = (d: Date) => shortTime(d, deps.timeZone);
    const names = new Map(targets.map((id) => [id, devices?.find((d) => d.id === id)?.name ?? id]));
    const zonesOf = (id: string) => zones.filter((z) => z.deviceId === id).map((z) => z.name);
    const bhyveWatering = (id: string) => Boolean(devices?.find((d) => d.id === id)?.status?.watering_status);

    let anythingOn = devices === undefined;
    const lines = targets.map((id) => {
      const parts: string[] = [];
      if (devices === undefined) parts.push("❓ B-hyve couldn't be asked");
      else if (bhyveWatering(id)) parts.push('💧 watering');
      else parts.push('not watering');
      const running = s.wateringNow.find((w) => w.deviceId === id);
      if (running) parts.push(`the conductor's cycle ${running.cycle}/${running.of} on until ${at(running.until)}`);
      const held = s.sequences.find((q) => q.deviceId === id);
      if (held) parts.push(`the conductor's next cycle ${held.nextCycle}/${held.cycles} ${s.paused ? 'on hold' : `due ${at(held.dueAt)}`}`);
      if (bhyveWatering(id) || running || held) anythingOn = true;
      return `• ${safe(names.get(id) ?? id)} (${safe(zonesOf(id).join(', '))}): ${parts.join(' · ')}`;
    });

    return confirm({
      text: fitLines([
        anythingOn ? '🛑 <b>Stop the water now?</b>' : '🛑 Nothing seems to be watering here. <b>Send the stop anyway?</b>',
        ...lines,
        '',
        "This turns the water off on these controllers (a run from your B-hyve schedule too; they go back to their normal schedule) and cancels the conductor's watering on them.",
        ...(s.paused ? [] : ['Automatic watering stays on: /pause keeps it from starting again.']),
        '',
        'Reply <b>yes</b> or <b>cancel</b>.',
      ]),
      hint: 'Reply yes to stop the water, or cancel.',
      then: () =>
        act('🛑 Stopping the water…', async () => formatStopped(await deps.stop.stopWatering(targets, via(actor)), names, Boolean(s.paused))),
    });
  },
});

/** What the stop did, controller by controller. Not sent anywhere counts as a failure. */
export const formatStopped = (results: readonly StopResult[], names: ReadonlyMap<string, string>, paused: boolean): RunResult => {
  const sent = results.filter((r) => r.sent).length;
  const lines = [
    sent === results.length
      ? '🛑 <b>Stop sent</b>'
      : sent === 0
        ? '❌ <b>The stop could not be sent</b>: use the B-hyve app'
        : '⚠️ <b>Stop sent to some controllers only</b>',
  ];
  for (const r of results) {
    const name = `${safe(names.get(r.deviceId) ?? r.deviceId)}${r.zoneNames.length > 0 ? ` (${safe(r.zoneNames.join(', '))})` : ''}`;
    let state: string;
    if (!r.sent) state = `❌ <b>not sent</b>: ${safe(r.error ?? 'unknown error', 150)}. Use the B-hyve app to stop it.`;
    else if (r.check === 'off') state = '✅ off';
    else if (r.check === 'watering') state = '⚠️ B-hyve still says it is watering (its status can lag): check /health in a minute, or use the B-hyve app';
    else state = "❓ sent, but B-hyve couldn't be asked whether it's off: check /health in a minute";
    const cancelled = r.cancelled ? ` · cancelled the conductor's watering (cycle ${r.cancelled.nextCycle}/${r.cancelled.cycles} was next)` : '';
    const resent = r.resent ? ' · a cycle was being sent at that moment: stopped again after it' : '';
    lines.push(`• ${name}: ${state}${cancelled}${resent}`);
  }
  if (!paused) lines.push('', 'Automatic watering is still on: /pause keeps it from starting again.');
  const text = fitLines(lines);
  const failed = results.filter((r) => !r.sent);
  return failed.length > 0 ? { text, error: `stop not sent to ${failed.map((r) => r.deviceId).join(', ')}` } : text;
};
