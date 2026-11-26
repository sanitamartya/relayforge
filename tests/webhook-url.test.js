import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";

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

test("parseWebhookUrl rejects empty, malformed, unsupported, and credentialed URLs", () => {
  const invalidUrls = [
    "",
    "not a URL",
    "ftp://hooks.customer.com/events",
    "https://user:pass@hooks.customer.com/events",
  ];

  for (const url of invalidUrls) {
    assert.throws(() => parseWebhookUrl(url));
  }

  assert.throws(() => parseWebhookUrl(null), /Webhook URL is required/);
  assert.throws(() => parseWebhookUrl("   "), /Webhook URL is required/);
});

test("parseWebhookUrl normalizes a public hostname with trailing dot", () => {
  const parsed = parseWebhookUrl("https://HOOKS.CUSTOMER.COM./events");

  assert.equal(parsed.hostname, "hooks.customer.com.");
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

test("sendWebhookRequest rejects a private IP before connecting", () => {
  assert.throws(() => sendWebhookRequest("http://127.0.0.1:8080/webhook"), /non-public IP address/);
});

test("resolvePublicWebhookAddresses accepts public DNS answers", async () => {
  const addresses = await resolvePublicWebhookAddresses("hooks.customer.com", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);

  assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
});

test("resolvePublicWebhookAddresses rejects mixed public and private DNS answers", async () => {
  await assert.rejects(
    resolvePublicWebhookAddresses("hooks.customer.com", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.12", family: 4 },
    ]),
    /non-public IP address/,
  );
});

test("resolvePublicWebhookAddresses rejects DNS lookup failures", async () => {
  await assert.rejects(
    resolvePublicWebhookAddresses("hooks.customer.com", async () => {
      throw new Error("DNS lookup failed");
    }),
    /hostname could not be resolved/,
  );
});

test("resolvePublicWebhookAddresses rejects an empty DNS result", async () => {
  await assert.rejects(
    resolvePublicWebhookAddresses("hooks.customer.com", async () => []),
    /did not resolve to an IP address/,
  );
});

test("resolvePublicWebhookAddresses returns a public IP literal without DNS", async () => {
  const addresses = await resolvePublicWebhookAddresses("93.184.216.34", async () => {
    assert.fail("DNS lookup must not be called for an IP literal");
  });

  assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
});

test("resolvePublicWebhookAddresses rejects local hostnames before DNS", async () => {
  await assert.rejects(
    resolvePublicWebhookAddresses("service.local", async () => {
      assert.fail("DNS lookup must not be called for a blocked hostname");
    }),
    /local or reserved hostname/,
  );
});

test("resolvePublicWebhookAddresses rejects a single non-public DNS answer", async () => {
  await assert.rejects(
    resolvePublicWebhookAddresses("hooks.customer.com", async () => [
      { address: "192.168.1.20", family: 4 },
    ]),
    /non-public IP address/,
  );
});

test("sendWebhookRequest sends the configured HTTP request and reports a 2xx response", async (t) => {
  let capturedUrl;
  let capturedOptions;
  let capturedBody;

  t.mock.method(http, "request", (url, options, callback) => {
    capturedUrl = url;
    capturedOptions = options;

    callback({
      statusCode: 204,
      resume() {},
    });

    const request = new EventEmitter();
    request.end = (body) => {
      capturedBody = body;
    };

    return request;
  });

  const result = await sendWebhookRequest("http://hooks.customer.com/events", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: '{"event":"created"}',
  });

  assert.equal(capturedUrl.hostname, "hooks.customer.com");
  assert.equal(capturedOptions.method, "PUT");
  assert.deepEqual(capturedOptions.headers, { "content-type": "application/json" });
  assert.equal(capturedOptions.agent, false);
  assert.equal(capturedOptions.maxHeaderSize, 16 * 1024);
  assert.equal(typeof capturedOptions.lookup, "function");
  assert.equal(capturedBody, '{"event":"created"}');
  assert.deepEqual(result, { status: 204, ok: true });
});

test("sendWebhookRequest reports non-2xx HTTP responses as unsuccessful", async (t) => {
  t.mock.method(http, "request", (_url, _options, callback) => {
    callback({
      statusCode: 503,
      resume() {},
    });

    const request = new EventEmitter();
    request.end = () => {};
    return request;
  });

  const result = await sendWebhookRequest("http://hooks.customer.com/events");

  assert.deepEqual(result, { status: 503, ok: false });
});

test("sendWebhookRequest rejects when the HTTP request emits an error", async (t) => {
  const requestError = new Error("connection reset");

  t.mock.method(https, "request", () => {
    const request = new EventEmitter();
    request.end = () => {
      request.emit("error", requestError);
    };
    return request;
  });

  await assert.rejects(
    sendWebhookRequest("https://hooks.customer.com/events"),
    (error) => error === requestError,
  );
});

async function capturePublicLookup(t) {
  let lookup;

  t.mock.method(http, "request", (_url, options, callback) => {
    lookup = options.lookup;

    callback({
      statusCode: 204,
      resume() {},
    });

    const request = new EventEmitter();
    request.end = () => {};

    return request;
  });

  await sendWebhookRequest("http://93.184.216.34/events");

  return lookup;
}

test("public lookup rejects a requested IP family with no matching address", async (t) => {
  const lookup = await capturePublicLookup(t);

  const result = await new Promise((resolve) => {
    lookup("93.184.216.34", { family: 6 }, (error, address, family) => {
      resolve({ error, address, family });
    });
  });

  assert.equal(result.error.code, "EAI_ADDRFAMILY");
});

test("public lookup returns all validated addresses when all is true", async (t) => {
  const lookup = await capturePublicLookup(t);

  const result = await new Promise((resolve) => {
    lookup("93.184.216.34", { all: true }, (error, addresses) => {
      resolve({ error, addresses });
    });
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.addresses, [{ address: "93.184.216.34", family: 4 }]);
});

test("public lookup returns the first address when all is not requested", async (t) => {
  const lookup = await capturePublicLookup(t);

  const result = await new Promise((resolve) => {
    lookup("93.184.216.34", {}, (error, address, family) => {
      resolve({ error, address, family });
    });
  });

  assert.equal(result.error, null);
  assert.equal(result.address, "93.184.216.34");
  assert.equal(result.family, 4);
});

test("public lookup forwards hostname validation and DNS errors to the callback", async (t) => {
  const lookup = await capturePublicLookup(t);

  const result = await new Promise((resolve) => {
    lookup("service.local", {}, (error, address, family) => {
      resolve({ error, address, family });
    });
  });

  assert.match(result.error.message, /local or reserved hostname/);
  assert.equal(result.address, undefined);
  assert.equal(result.family, undefined);
});

test("public lookup filters matching address family when returning all addresses", async (t) => {
  const lookup = await capturePublicLookup(t);

  const result = await new Promise((resolve) => {
    lookup("93.184.216.34", { family: 4, all: true }, (error, addresses) => {
      resolve({ error, addresses });
    });
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.addresses, [{ address: "93.184.216.34", family: 4 }]);
});
