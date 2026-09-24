import { lookup as dnsLookup } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { createServer } from 'node:http';
import { connect as tcpConnect, isIP } from 'node:net';

const REQUIRED_DESTINATIONS = Object.freeze([
  'github.com', 'api.github.com', '*.actions.githubusercontent.com', 'codeload.github.com',
  'results-receiver.actions.githubusercontent.com', '*.blob.core.windows.net',
]);
const MAX_HOSTS = 64;
const IPV4_NON_PUBLIC = Object.freeze([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['168.63.129.16', 32],
]);

export class EgressPolicyRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'EgressPolicyRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new EgressPolicyRefusal(code);
}

function ipv4Number(value) {
  if (isIP(value) !== 4) return null;
  return value.split('.').reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function ipv4RangeContains(address, network, prefix) {
  const actual = ipv4Number(address);
  const base = ipv4Number(network);
  if (actual === null || base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (actual & mask) === (base & mask);
}

function ipv6Groups(value) {
  if (isIP(value) !== 6 || value.includes('%')) return null;
  let address = value.toLowerCase();
  if (address.includes('.')) {
    const split = address.lastIndexOf(':');
    const v4 = ipv4Number(address.slice(split + 1));
    if (v4 === null) return null;
    address = `${address.slice(0, split)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function ipv6IsPublic(value) {
  const groups = ipv6Groups(value);
  if (!groups) return false;
  const first = groups[0];
  // Only global-unicast 2000::/3 is accepted. Documentation and protocol-special ranges are denied.
  if ((first & 0xe000) !== 0x2000) return false;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false;
  if (groups[0] === 0x2001 && groups[1] === 0) return false;
  return true;
}

function validExactHostname(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.trim()) return false;
  const ascii = domainToASCII(value.toLowerCase());
  if (!ascii || ascii !== ascii.toLowerCase() || ascii.endsWith('.') || isIP(ascii)) return false;
  const labels = ascii.split('.');
  return labels.length >= 2 && labels.every((label) => label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label));
}

export function buildEgressAllowlist(additionalHosts = []) {
  if (!Array.isArray(additionalHosts) || additionalHosts.length > MAX_HOSTS) {
    refuse('egress_destination_not_allowlisted');
  }
  const hosts = [...REQUIRED_DESTINATIONS];
  for (const host of additionalHosts) {
    if (!validExactHostname(host) || REQUIRED_DESTINATIONS.includes(host)) {
      refuse('egress_destination_not_allowlisted');
    }
    hosts.push(host.toLowerCase());
  }
  const unique = [...new Set(hosts)];
  if (unique.length > MAX_HOSTS) refuse('egress_destination_not_allowlisted');
  return Object.freeze(unique);
}

export function assertAllowedProxyHost(host, allowedHosts) {
  if (!validExactHostname(host) || !Array.isArray(allowedHosts)) refuse('egress_destination_not_allowlisted');
  const normalized = domainToASCII(host.toLowerCase());
  const allowed = allowedHosts.some((rule) => {
    if (typeof rule !== 'string') return false;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2).toLowerCase();
      return normalized.endsWith(`.${suffix}`) && normalized !== suffix;
    }
    return normalized === rule.toLowerCase();
  });
  if (!allowed) refuse('egress_destination_not_allowlisted');
  return normalized;
}

export function assertPublicAddresses(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) refuse('egress_dns_refused');
  for (const entry of addresses) {
    const address = entry?.address;
    const family = isIP(address ?? '');
    if (family === 4) {
      if (IPV4_NON_PUBLIC.some(([network, prefix]) => ipv4RangeContains(address, network, prefix))) {
        refuse('egress_private_address_refused');
      }
    } else if (family === 6) {
      if (!ipv6IsPublic(address)) refuse('egress_private_address_refused');
    } else {
      refuse('egress_dns_refused');
    }
  }
  return true;
}

function parseConnectAuthority(authority, allowedHosts) {
  if (typeof authority !== 'string' || authority.length > 255 || /[\s/@?#]/u.test(authority)) {
    refuse('egress_destination_not_allowlisted');
  }
  const match = /^([^:]+):([0-9]{1,5})$/u.exec(authority);
  if (!match || match[2] !== '443') refuse('egress_destination_not_allowlisted');
  return { host: assertAllowedProxyHost(match[1].replace(/\.$/u, ''), allowedHosts), port: 443 };
}

export async function authorizeEgressTarget(authority, { allowedHosts, lookup = dnsLookup } = {}) {
  if (!Array.isArray(allowedHosts) || typeof lookup !== 'function') refuse('egress_proxy_config_invalid');
  const target = parseConnectAuthority(authority, allowedHosts);
  let addresses;
  try { addresses = await lookup(target.host, { all: true, verbatim: true }); }
  catch { refuse('egress_dns_refused'); }
  assertPublicAddresses(addresses);
  return Object.freeze({ ...target, address: addresses[0].address, family: addresses[0].family });
}

export function createEgressProxyServer({ allowedHosts, lookup = dnsLookup, connect = tcpConnect } = {}) {
  if (!Array.isArray(allowedHosts) || typeof lookup !== 'function' || typeof connect !== 'function') {
    refuse('egress_proxy_config_invalid');
  }
  const rules = buildEgressAllowlist(allowedHosts.filter((host) => !REQUIRED_DESTINATIONS.includes(host)));
  if (rules.length !== allowedHosts.length || rules.some((host, index) => host !== allowedHosts[index])) {
    refuse('egress_proxy_config_invalid');
  }
  const server = createServer((request, response) => {
    if (request.url === '/health' && request.method === 'GET' &&
        ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(403, { connection: 'close' }).end();
  });
  server.maxConnections = 128;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.on('connect', async (request, client, head) => {
    let upstream;
    try {
      const target = await authorizeEgressTarget(request.url, { allowedHosts: rules, lookup });
      upstream = connect({ host: target.address, family: target.family, port: target.port });
      await new Promise((resolve, reject) => {
        const onError = () => reject(new EgressPolicyRefusal('egress_upstream_unavailable'));
        upstream.once('error', onError);
        upstream.once('connect', () => {
          upstream.removeListener('error', onError);
          resolve();
        });
      });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    } catch {
      upstream?.destroy();
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  let allowedHosts;
  try { allowedHosts = JSON.parse(process.env.BVC_EGRESS_ALLOWLIST ?? ''); }
  catch { process.exit(70); }
  let server;
  try { server = createEgressProxyServer({ allowedHosts }); }
  catch { process.exit(70); }
  server.listen(3128, '0.0.0.0');
}
