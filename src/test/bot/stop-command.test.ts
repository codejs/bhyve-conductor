import { describe, expect, it, vi } from 'vitest';
import type { InputResult, Step } from '../../bot/conversation.ts';
import { buildStopCommand, formatStopped, type WaterStop } from '../../bot/stop-command.ts';
import type { BhyveDevice } from '../../bhyve/types.ts';
import type { StopResult } from '../../conductor/monitor.ts';
import { conductorStatus } from '../utils/bot.ts';
import { bhyveDevice, NOW } from '../utils/conductor.ts';

const OWNER = { id: 4242, username: 'owner' };
const MIN = 60_000;
const ZONES = [
  { key: 'dev1:1', name: 'Front lawn', deviceId: 'dev1' },
  { key: 'dev1:2', name: 'Back lawn', deviceId: 'dev1' },
  { key: 'dev2:1', name: 'Beds', deviceId: 'dev2' },
];
const wellFormed = (html: string) => expect(html.replace(/<\/?(b|i|code)>/g, '')).not.toMatch(/[<>]/);

const stopped = (deviceId: string, overrides: Partial<StopResult> = {}): StopResult => ({
  deviceId,
  zoneNames: ZONES.filter((z) => z.deviceId === deviceId).map((z) => z.name),
  sent: true,
  check: 'off',
  ...overrides,
});

const setup = (opts: { devices?: BhyveDevice[] | Error; status?: Parameters<typeof conductorStatus>[0] } = {}) => {
  const stop: WaterStop & { stopWatering: ReturnType<typeof vi.fn> } = {
    zones: () => ZONES,
    status: () => conductorStatus(opts.status ?? {}),
    devices: vi.fn(async () => {
      if (opts.devices instanceof Error) throw opts.devices;
      return opts.devices ?? [bhyveDevice('dev1', { name: 'Front timer', status: { run_mode: 'auto', watering_status: { current_station: 2 } } }), bhyveDevice('dev2', { name: 'Side timer' })];
    }),
    stopWatering: vi.fn(async (ids: readonly string[]) => ids.map((id) => stopped(id))),
  };
  const command = buildStopCommand({ stop, timeZone: 'UTC' });
  return { stop, command, begin: (args = '') => Promise.resolve(command.begin(OWNER, args)) };
};

const yes = async (step: Step): Promise<Step> => {
  if (step.kind !== 'input') throw new Error(`expected a question, got ${step.kind}`);
  const r: InputResult = await step.read('yes');
  if (!('next' in r)) throw new Error('yes not accepted');
  return r.next;
};
const act = async (step: Step) => {
  if (step.kind !== 'act') throw new Error(`expected an act step, got ${step.kind}`);
  return step.run();
};

describe('/stop', () => {
  it('is a safety command that takes a zone', () => {
    expect(setup().command).toMatchObject({ kind: 'safety', name: 'stop', acceptsArgs: true });
  });

  it('shows what is on everywhere, and asks to confirm', async () => {
    const t = setup({
      status: {
        wateringNow: [{ deviceId: 'dev1', zoneNames: ['Front lawn'], cycle: 1, of: 3, until: new Date(NOW.getTime() + 8 * MIN) }],
        sequences: [{ id: 'q', deviceId: 'dev1', zoneNames: ['Front lawn'], nextCycle: 2, cycles: 3, dueAt: new Date(NOW.getTime() + 38 * MIN), attempts: 0, stale: false }],
      },
    });
    const step = await t.begin();

    expect(step).toMatchObject({
      kind: 'input',
      hint: 'Reply yes to stop the water, or cancel.',
      text: [
        '🛑 <b>Stop the water now?</b>',
        "• Front timer (Front lawn, Back lawn): 💧 watering · the conductor's cycle 1/3 on until Jul 1, 12:08 · the conductor's next cycle 2/3 due Jul 1, 12:38",
        '• Side timer (Beds): not watering',
        '',
        "This turns the water off on these controllers (a run from your B-hyve schedule too; they go back to their normal schedule) and cancels the conductor's watering on them.",
        'Automatic watering stays on: /pause keeps it from starting again.',
        '',
        'Reply <b>yes</b> or <b>cancel</b>.',
      ].join('\n'),
    });
    expect(t.stop.stopWatering).not.toHaveBeenCalled(); // nothing before the confirmation
  });

  it('stops after "yes", saying first that it is stopping', async () => {
    const t = setup();
    const next = await yes(await t.begin());

    expect(next).toMatchObject({ kind: 'act', text: '🛑 Stopping the water…' });
    const reply = await act(next);

    expect(t.stop.stopWatering).toHaveBeenCalledWith(['dev1', 'dev2'], '@owner via Telegram');
    expect(reply).toBe(
      [
        '🛑 <b>Stop sent</b>',
        '• Front timer (Front lawn, Back lawn): ✅ off',
        '• Side timer (Beds): ✅ off',
        '',
        'Automatic watering is still on: /pause keeps it from starting again.',
      ].join('\n'),
    );
  });

  it.each(['1', '2', 'front lawn', 'Back Lawn'])('stops only the controller of the zone given: %j', async (args) => {
    const t = setup();
    const step = await t.begin(args);
    expect(step.kind === 'input' && step.text).toContain('• Front timer (Front lawn, Back lawn)');
    expect(step.kind === 'input' && step.text).not.toContain('Side timer');
    await act(await yes(step));
    expect(t.stop.stopWatering).toHaveBeenCalledWith(['dev1'], '@owner via Telegram');
  });

  it('takes "all"', async () => {
    const t = setup();
    await act(await yes(await t.begin('ALL')));
    expect(t.stop.stopWatering).toHaveBeenCalledWith(['dev1', 'dev2'], '@owner via Telegram');
  });

  it('lists the zones when the one given is not there, without repeating what was typed', async () => {
    const t = setup();
    expect(await t.begin('secret-passphrase')).toEqual({
      kind: 'done',
      text: '⚠️ That is not one of the zones. Send /stop for all of them, or one of:\n1. Front lawn\n2. Back lawn\n3. Beds',
    });
  });

  it('still offers to stop when nothing seems to be watering (B-hyve can lag)', async () => {
    const t = setup({ devices: [bhyveDevice('dev1'), bhyveDevice('dev2')] });
    const step = await t.begin();
    expect(step.kind === 'input' && step.text.split('\n')[0]).toBe('🛑 Nothing seems to be watering here. <b>Send the stop anyway?</b>');
    await act(await yes(step));
    expect(t.stop.stopWatering).toHaveBeenCalled();
  });

  it('still offers to stop when B-hyve cannot be asked', async () => {
    const t = setup({ devices: new Error('HTTP 503') });
    const step = await t.begin();
    expect(step.kind === 'input' && step.text).toContain("🛑 <b>Stop the water now?</b>\n• dev1 (Front lawn, Back lawn): ❓ B-hyve couldn't be asked");
  });

  it('says watering on hold is on hold, and leaves out the /pause hint while paused', async () => {
    const t = setup({
      status: {
        paused: { since: NOW, by: 'x' },
        sequences: [{ id: 'q', deviceId: 'dev2', zoneNames: ['Beds'], nextCycle: 2, cycles: 3, dueAt: NOW, attempts: 0, stale: false }],
      },
    });
    const step = await t.begin();
    expect(step.kind === 'input' && step.text).toContain("• Side timer (Beds): not watering · the conductor's next cycle 2/3 on hold");
    expect(step.kind === 'input' && step.text).not.toContain('/pause');
    const reply = await act(await yes(step));
    expect(reply).not.toContain('/pause');
  });

  it('says so when there are no zones', async () => {
    const t = setup();
    t.stop.zones = () => [];
    expect(await t.begin()).toEqual({ kind: 'done', text: 'No zones are configured.' });
  });

  it('escapes controller names from B-hyve', async () => {
    const t = setup({ devices: [bhyveDevice('dev1', { name: '<b>x</b> & <script>' })] });
    const step = await t.begin();
    wellFormed(step.kind === 'input' ? step.text : '');
  });
});

describe('formatStopped', () => {
  const names = new Map([
    ['dev1', 'Front timer'],
    ['dev2', 'Side timer'],
  ]);

  it('says, per controller, whether the water is off, and what else happened', () => {
    const text = formatStopped(
      [
        stopped('dev1', { cancelled: { id: 'q', deviceId: 'dev1', zoneNames: [], nextCycle: 2, cycles: 3, dueAt: NOW, attempts: 0, stale: false }, resent: true }),
        stopped('dev2', { check: 'watering' }),
        stopped('dev3', { zoneNames: [], check: 'unknown' }),
      ],
      names,
      false,
    );
    expect(text).toBe(
      [
        '🛑 <b>Stop sent</b>',
        "• Front timer (Front lawn, Back lawn): ✅ off · cancelled the conductor's watering (cycle 2/3 was next) · a cycle was being sent at that moment: stopped again after it",
        '• Side timer (Beds): ⚠️ B-hyve still says it is watering (its status can lag): check /health in a minute, or use the B-hyve app',
        "• dev3: ❓ sent, but B-hyve couldn't be asked whether it's off: check /health in a minute",
        '',
        'Automatic watering is still on: /pause keeps it from starting again.',
      ].join('\n'),
    );
  });

  it('reports a stop that could not be sent as a failure, pointing to the B-hyve app', () => {
    const result = formatStopped([stopped('dev1', { sent: false, error: 'B-hyve socket did not open within 15s', check: 'unknown' }), stopped('dev2')], names, true);
    expect(result).toEqual({
      text: [
        '⚠️ <b>Stop sent to some controllers only</b>',
        '• Front timer (Front lawn, Back lawn): ❌ <b>not sent</b>: B-hyve socket did not open within 15s. Use the B-hyve app to stop it.',
        '• Side timer (Beds): ✅ off',
      ].join('\n'),
      error: 'stop not sent to dev1',
    });
  });

  it('says plainly when the stop could not be sent at all', () => {
    const result = formatStopped([stopped('dev1', { sent: false, error: 'B-hyve socket did not open within 15s', check: 'unknown' })], names, true);
    expect(typeof result !== 'string' && result.text.split('\n')[0]).toBe('❌ <b>The stop could not be sent</b>: use the B-hyve app');
  });

  it('escapes', () => {
    const result = formatStopped([stopped('<i>', { sent: false, error: '<b>', zoneNames: ['<x>'] })], new Map([['<i>', '<s>']]), false);
    wellFormed(typeof result === 'string' ? result : result.text);
  });
});
