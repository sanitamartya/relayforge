import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isPublicIpAddress,
  parseWebhookUrl,
  resolvePublicWebhookAddresses,
  sendWebhookRequest,
} from "../src/security/webhook-url.js";

test("isPublicIpAddress accepts globally routable IPv4 and IPv6", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("1.1.1.1"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
});

test("isPublicIpAddress rejects private and special-purpose addresses", () => {
  const blockedAddresses = [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2002::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ];

  for (const address of blockedAddresses) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test("parseWebhookUrl accepts a public HTTPS destination", () => {
  const parsed = parseWebhookUrl("https://hooks.customer.com/webhooks");

  assert.equal(parsed.protocol, "https:");
  assert.equal(parsed.hostname, "hooks.customer.com");
});

test("parseWebhookUrl rejects local hostnames and private IP literals", () => {
  const blockedUrls = [
    "http://localhost:8080/webhook",
    "http://service.local/webhook",
    "http://api.internal/webhook",
    "http://127.0.0.1/webhook",
    "http://10.0.0.5/webhook",
    "http://[::1]/webhook",
    "http://[fc00::1]/webhook",
  ];

  for (const url of blockedUrls) {
    assert.throws(() => parseWebhookUrl(url), /local or reserved|non-public/);
  }
});

test("sendWebhookRequest rejects a private IP before connecting", async () => {
  await assert.rejects(
    sendWebhookRequest("http://127.0.0.1:8080/webhook"),
    /non-public IP address/,
  );
});

test("resolvePublicWebhookAddresses accepts public DNS answers", async () => {
  const addresses = await resolvePublicWebhookAddresses(
    "hooks.customer.com",
    async () => [{ address: "93.184.216.34", family: 4 }],
  );

  assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
});

test("resolvePublicWebhookAddresses rejects mixed public and private DNS answers", async () => {
  await assert.rejects(
    resolvePublicWebhookAddresses(
      "hooks.customer.com",
      async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.12", family: 4 },
      ],
    ),
    /non-public IP address/,
  );
});
