import http from "node:http";

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let body = "";

  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    console.log("\n--- Webhook received ---");
    console.log("Event ID:", req.headers["x-relayforge-event-id"]);
    console.log("Delivery ID:", req.headers["x-relayforge-delivery-id"]);
    console.log("Idempotency Key:", req.headers["idempotency-key"]);
    console.log("Event Type:", req.headers["x-relayforge-event-type"]);
    console.log("Payload:", body);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));
  });
});

server.listen(4000, "127.0.0.1", () => {
  console.log("Webhook receiver listening on http://127.0.0.1:4000");
});
