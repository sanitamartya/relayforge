import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { URL } from "node:url";

const IPV4_BLOCKED_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

const IPV6_BLOCKED_CIDRS = [
  "::/128",
  "::1/128",
  "::ffff:0:0/96",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".test",
  ".invalid",
  ".example",
];

function normalizeHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

function ipv4ToBigInt(address) {
  const octets = address.split(".").map(Number);

  if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) {
    return null;
  }

  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6ToBigInt(address) {
  let normalized = address.split("%")[0].toLowerCase();

  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = ipv4ToBigInt(normalized.slice(lastColon + 1));

    if (ipv4 === null) {
      return null;
    }

    const firstHextet = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const secondHextet = Number(ipv4 & 0xffffn).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${firstHextet}:${secondHextet}`;
  }

  const halves = normalized.split("::");

  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missingGroups = 8 - left.length - right.length;

  if ((halves.length === 1 && missingGroups !== 0) || missingGroups < 0) {
    return null;
  }

  const groups =
    halves.length === 2
      ? [...left, ...Array(missingGroups).fill("0"), ...right]
      : left;

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }

  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}

function isInCidr(addressValue, cidr, parseAddress) {
  const [network, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  const networkValue = parseAddress(network);

  if (addressValue === null || networkValue === null) {
    return false;
  }

  const bitCount = parseAddress === ipv4ToBigInt ? 32n : 128n;
  const shift = bitCount - BigInt(prefix);

  return (addressValue >> shift) === (networkValue >> shift);
}

export function isPublicIpAddress(address) {
  const normalized = normalizeHostname(address);
  const version = isIP(normalized);

  if (version === 4) {
    const value = ipv4ToBigInt(normalized);

    return !IPV4_BLOCKED_CIDRS.some((cidr) => isInCidr(value, cidr, ipv4ToBigInt));
  }

  if (version === 6) {
    const value = ipv6ToBigInt(normalized);

    if (!isInCidr(value, "2000::/3", ipv6ToBigInt)) {
      return false;
    }

    return !IPV6_BLOCKED_CIDRS.some((cidr) => isInCidr(value, cidr, ipv6ToBigInt));
  }

  return false;
}

function isBlockedHostname(hostname) {
  if (!hostname.includes(".") || hostname === "localhost") {
    return true;
  }

  return BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

export function parseWebhookUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Webhook URL is required");
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(value.trim());
  } catch {
    throw new Error("Webhook URL must be a valid URL");
  }

  const hostname = normalizeHostname(parsedUrl.hostname);

  if (
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    !hostname ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error(
      "Webhook URL must use HTTP or HTTPS and cannot contain credentials",
    );
  }

  if (isBlockedHostname(hostname)) {
    throw new Error("Webhook URL cannot target a local or reserved hostname");
  }

  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    throw new Error("Webhook URL cannot target a non-public IP address");
  }

  return parsedUrl;
}

export async function resolvePublicWebhookAddresses(hostname, lookup = dnsLookup) {
  const normalized = normalizeHostname(hostname);
  const version = isIP(normalized);

  if (version) {
    if (!isPublicIpAddress(normalized)) {
      throw new Error("Webhook destination is a non-public IP address");
    }

    return [{ address: normalized, family: version }];
  }

  if (isBlockedHostname(normalized)) {
    throw new Error("Webhook destination cannot target a local or reserved hostname");
  }

  let addresses;

  try {
    addresses = await lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new Error("Webhook hostname could not be resolved");
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error("Webhook hostname did not resolve to an IP address");
  }

  for (const record of addresses) {
    if (!isPublicIpAddress(record.address)) {
      throw new Error(
        `Webhook hostname resolves to a non-public IP address (${record.address})`,
      );
    }
  }

  return addresses;
}

function createPublicLookup() {
  return (hostname, options, callback) => {
    resolvePublicWebhookAddresses(hostname)
      .then((addresses) => {
        const matchingAddresses = options?.family
          ? addresses.filter((address) => address.family === options.family)
          : addresses;

        if (matchingAddresses.length === 0) {
          const error = new Error("No webhook address matches the requested IP family");
          error.code = "EAI_ADDRFAMILY";
          callback(error);
          return;
        }

        if (options?.all) {
          callback(null, matchingAddresses);
          return;
        }

        callback(
          null,
          matchingAddresses[0].address,
          matchingAddresses[0].family,
        );
      })
      .catch(callback);
  };
}

export function sendWebhookRequest(url, options = {}) {
  const parsedUrl = parseWebhookUrl(url);
  const transport = parsedUrl.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      parsedUrl,
      {
        method: options.method ?? "POST",
        headers: options.headers,
        signal: options.signal,
        agent: false,
        lookup: createPublicLookup(),
        maxHeaderSize: 16 * 1024,
      },
      (response) => {
        const status = response.statusCode ?? 0;

        response.resume();

        resolve({
          status,
          ok: status >= 200 && status < 300,
        });
      },
    );

    request.on("error", reject);
    request.end(options.body);
  });
}
