import { describe, expect, it } from 'vitest';
import { allowedHostsFor, isAllowedHost, isLoopback, isWildcard, LOOPBACK_HOSTS, normalizeHost } from '../../http/hosts.ts';

/** Which host names the web server answers to: the defence against DNS rebinding. */

describe('normalizeHost', () => {
  it.each([
    ['localhost', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['  Garden-Pi.Local  ', 'garden-pi.local'],
    ['garden-pi.local.', 'garden-pi.local'],
    ['::1', '[::1]'],
    ['[::1]', '[::1]'],
    ['fe80::1', '[fe80::1]'],
    ['127.0.0.1', '127.0.0.1'],
  ])('%j → %j (as URL#hostname has it)', (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });
});

describe('isLoopback / isWildcard', () => {
  it.each(['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'LocalHost'])('%s is this machine only', (host) => {
    expect(isLoopback(host)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'garden-pi.local', '127.0.0.1.evil.example', 'localhost.evil.example', '1270.0.0.1'])(
    '%s is not loopback',
    (host) => {
      expect(isLoopback(host)).toBe(false);
    },
  );

  it.each(['0.0.0.0', '::', '[::]'])('%s listens on every interface', (host) => {
    expect(isWildcard(host)).toBe(true);
  });

  it.each(['127.0.0.1', '192.168.1.10', 'localhost'])('%s is one address', (host) => {
    expect(isWildcard(host)).toBe(false);
  });
});

describe('allowedHostsFor', () => {
  it('by default: only the loopback names', () => {
    expect(allowedHostsFor('127.0.0.1')).toEqual([...LOOPBACK_HOSTS]);
  });

  it('adds the address it listens on, normalized, once', () => {
    expect(allowedHostsFor('192.168.1.10')).toEqual([...LOOPBACK_HOSTS, '192.168.1.10']);
    expect(allowedHostsFor('::1')).toEqual([...LOOPBACK_HOSTS]);
    expect(allowedHostsFor('fd00::5')).toEqual([...LOOPBACK_HOSTS, '[fd00::5]']);
  });

  it('never adds a wildcard address: that is not a name any browser uses', () => {
    expect(allowedHostsFor('0.0.0.0')).toEqual([...LOOPBACK_HOSTS]);
    expect(allowedHostsFor('::')).toEqual([...LOOPBACK_HOSTS]);
  });

  it('adds the extra names, normalized and without duplicates', () => {
    expect(allowedHostsFor('0.0.0.0', ['Garden-Pi.local', 'garden-pi.local.', ' 192.168.1.10 ', ''])).toEqual([
      ...LOOPBACK_HOSTS,
      'garden-pi.local',
      '192.168.1.10',
    ]);
  });
});

describe('isAllowedHost', () => {
  const allowed = new Set(allowedHostsFor('127.0.0.1', ['garden-pi.local']));

  it.each([
    'http://localhost/api/simulations',
    'http://localhost:8787/api/simulations',
    'http://127.0.0.1:1234/',
    'http://[::1]:8787/api',
    'http://LOCALHOST:8787/api',
    'http://localhost.:8787/api',
    'http://garden-pi.local:8787/api',
  ])('answers %s', (url) => {
    expect(isAllowedHost(url, allowed)).toBe(true);
  });

  it.each([
    // DNS rebinding: the attacker's own name, now resolving to this machine.
    'http://rebind.evil.example:8787/api/simulations',
    'http://localhost.evil.example/api',
    'http://127.0.0.1.nip.io/api',
    'http://evil.example@localhost.evil.example/api',
    // Other addresses of this machine it wasn't told about.
    'http://192.168.1.10:8787/api',
    'http://0.0.0.0:8787/api',
    'http://[::ffff:127.0.0.1]/api',
  ])('refuses %s', (url) => {
    expect(isAllowedHost(url, allowed)).toBe(false);
  });

  it.each(['http://2130706433/api', 'http://0x7f.1/api', 'http://127.1/api'])(
    'numeric forms of 127.0.0.1 (%s) are canonicalized by the URL parser, as browsers do, so they are loopback',
    (url) => {
      expect(new URL(url).hostname).toBe('127.0.0.1');
      expect(isAllowedHost(url, allowed)).toBe(true);
    },
  );

  it('refuses what is not a URL', () => {
    expect(isAllowedHost('not a url', allowed)).toBe(false);
    expect(isAllowedHost('', allowed)).toBe(false);
  });

  it('userinfo does not smuggle an allowed name in', () => {
    // The host is evil.example; "localhost" is only the user name.
    expect(isAllowedHost('http://localhost@evil.example/api', allowed)).toBe(false);
  });
});
