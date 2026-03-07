/**
 * Device Authorization Flow
 *
 * 1. POST /api/auth/device/code → get device_code + user_code
 * 2. Open browser to /auth/device?code=XXXX-XXXX
 * 3. Poll /api/auth/device/token until approved
 * 4. Save or print API key
 *
 * Zero dependencies — uses only Node 18+ built-ins.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";

/**
 * Open a URL in the default browser (platform-aware).
 */
function openBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" :
    platform === "win32" ? "start" :
    "xdg-open";

  exec(`${cmd} "${url}"`, (err) => {
    if (err) {
      // Silently fail — user can open the URL manually
    }
  });
}

/**
 * Sleep for ms milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the device auth flow.
 */
export async function deviceAuth({ format = "json", baseUrl = "https://fibuki.com" }) {
  console.log("\n  FiBuKI — Device Authorization\n");

  // Step 1: Request device code
  const codeRes = await fetch(`${baseUrl}/api/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!codeRes.ok) {
    const err = await codeRes.json().catch(() => ({}));
    throw new Error(err.error || `Failed to start auth flow (HTTP ${codeRes.status})`);
  }

  const { device_code, user_code, verification_uri, expires_in, interval } = await codeRes.json();

  // Step 2: Show instructions and open browser
  const browserUrl = `${verification_uri}?code=${encodeURIComponent(user_code)}`;

  console.log(`  Your code:  ${user_code}\n`);
  console.log(`  Opening browser to: ${browserUrl}`);
  console.log(`  (If the browser doesn't open, visit the URL above manually)\n`);
  console.log(`  Waiting for approval...`);

  openBrowser(browserUrl);

  // Step 3: Poll for approval
  let pollInterval = (interval || 5) * 1000;
  const deadline = Date.now() + expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const tokenRes = await fetch(`${baseUrl}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code,
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenRes.ok && tokenData.access_token) {
      // Success!
      console.log(`\n  Authorized! Key "${tokenData.key_name}" created.\n`);
      outputResult({ format, apiKey: tokenData.access_token, keyName: tokenData.key_name, baseUrl });
      return;
    }

    if (tokenData.error === "authorization_pending") {
      process.stdout.write(".");
      continue;
    }

    if (tokenData.error === "slow_down") {
      pollInterval += 2000;
      continue;
    }

    if (tokenData.error === "expired_token") {
      throw new Error("Code expired. Please run the command again.");
    }

    throw new Error(tokenData.error_description || tokenData.error || "Unknown error");
  }

  throw new Error("Timed out waiting for approval. Please run the command again.");
}

/**
 * Output the API key in the requested format.
 */
function outputResult({ format, apiKey, keyName, baseUrl }) {
  if (format === "env") {
    console.log(`  FIBUKI_API_KEY=${apiKey}\n`);
    return;
  }

  if (format === "mcp") {
    const mcpUrl = baseUrl.endsWith("/") ? `${baseUrl}api/mcp/sse` : `${baseUrl}/api/mcp/sse`;
    const config = {
      mcpServers: {
        fibuki: {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
      },
    };
    console.log("  Add this to your Claude Desktop config:\n");
    console.log(JSON.stringify(config, null, 2));
    console.log("");
    return;
  }

  // Default: save to ~/.fibuki/config.json
  const configDir = join(homedir(), ".fibuki");
  const configPath = join(configDir, "config.json");

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const config = { apiKey, keyName };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  console.log(`  Saved to ${configPath}\n`);
}
