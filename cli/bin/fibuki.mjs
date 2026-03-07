#!/usr/bin/env node

/**
 * FiBuKI CLI
 *
 * Usage:
 *   npx @fibukiapp/cli auth             Save API key to ~/.fibuki/config.json
 *   npx @fibukiapp/cli auth --format mcp   Print Claude Desktop MCP config
 *   npx @fibukiapp/cli auth --format env   Print FIBUKI_API_KEY=fk_xxx
 */

import { deviceAuth } from "../lib/auth.mjs";

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log(`
  FiBuKI CLI — authenticate and configure AI integrations

  Usage:
    fibuki auth              Authenticate via browser and save API key
    fibuki auth --format mcp Print Claude Desktop MCP config snippet
    fibuki auth --format env Print FIBUKI_API_KEY export

  Options:
    --format <type>   Output format: json (default), mcp, env
    --base-url <url>  Override API base URL (for development)
    --help            Show this help message
`);
  process.exit(0);
}

if (command === "auth") {
  const formatIdx = args.indexOf("--format");
  const format = formatIdx !== -1 ? args[formatIdx + 1] : "json";

  const baseUrlIdx = args.indexOf("--base-url");
  const baseUrl = baseUrlIdx !== -1 ? args[baseUrlIdx + 1] : "https://fibuki.com";

  if (!["json", "mcp", "env"].includes(format)) {
    console.error(`Unknown format: ${format}. Use json, mcp, or env.`);
    process.exit(1);
  }

  deviceAuth({ format, baseUrl }).catch((err) => {
    console.error("\nError:", err.message);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}. Run 'fibuki --help' for usage.`);
  process.exit(1);
}
