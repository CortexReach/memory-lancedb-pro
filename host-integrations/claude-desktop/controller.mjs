#!/usr/bin/env node

import net from "node:net";
const host = "127.0.0.1";
const port = 43129;
const [, , action, ...rest] = process.argv;

if (!["send", "new-chat", "read-last-assistant", "inspect-messages"].includes(action)) {
  console.error('Usage: controller.mjs send "message text"');
  console.error("   or: controller.mjs new-chat");
  console.error("   or: controller.mjs read-last-assistant");
  console.error("   or: controller.mjs inspect-messages");
  process.exit(1);
}

const text = rest.join(" ").trim();
if (action === "send" && !text) {
  console.error("Message text is required.");
  process.exit(1);
}

const payload = JSON.stringify(
  action === "send"
    ? { action: "send", text }
    : action === "new-chat"
      ? { action: "new-chat" }
      : action === "read-last-assistant"
        ? { action: "read-last-assistant" }
        : { action: "inspect-messages" },
);

const client = net.createConnection({ host, port });
let response = "";

client.setEncoding("utf8");
client.on("connect", () => {
  client.write(`${payload}\n`);
});
client.on("data", (chunk) => {
  response += chunk;
});
client.on("end", () => {
  if (!response.trim()) {
    console.error("No response from Claude Desktop control server.");
    process.exit(1);
  }
  console.log(response.trim());
});
client.on("close", () => {
  if (!response.trim()) {
    console.error("No response from Claude Desktop control server.");
    process.exit(1);
  }
});
client.on("error", (error) => {
  console.error(`Claude Desktop control failed: ${error.message}`);
  process.exit(1);
});
