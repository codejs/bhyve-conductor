import { isIP } from 'node:net';

/**
 * Which host names the web server answers to. The API has no login, so it relies on who can reach it; a
 * browser can be tricked into reaching it from another site through DNS rebinding (a site's own name
 * re-pointed at 127.0.0.1). Those requests carry the attacker's host name in the Host header, so anything
 * not on this list is refused.
 */

/** How a browser names this machine. URL hostnames put IPv6 addresses in brackets. */
export const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** Binding to these listens on every interface; they are not names a browser uses. */
const WILDCARD_BINDS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '[::]']);

/** A host name as URL#hostname has it: lower case, no trailing dot, IPv6 in brackets. */
export const normalizeHost = (host: string): string => {
  let h = host.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (!h.startsWith('[') && isIP(h) === 6) h = `[${h}]`;
  return h;
};

/** True for addresses only this machine can reach. */
export const isLoopback = (host: string): boolean => {
  const h = normalizeHost(host);
  return h === 'localhost' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
};

export const isWildcard = (host: string): boolean => WILDCARD_BINDS.has(normalizeHost(host));

/** The loopback names, the address it listens on (unless that is every interface) and any extra names. */
export const allowedHostsFor = (bindHost: string, extra: readonly string[] = []): string[] => {
  const hosts = [...LOOPBACK_HOSTS, ...(isWildcard(bindHost) ? [] : [bindHost]), ...extra].map(normalizeHost).filter(Boolean);
  return [...new Set(hosts)];
};

/** Whether a request URL's host name is on the list. */
export const isAllowedHost = (url: string, allowed: ReadonlySet<string>): boolean => {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return allowed.has(normalizeHost(hostname));
};
