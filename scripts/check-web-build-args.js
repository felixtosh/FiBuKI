#!/usr/bin/env node

/**
 * Every build arg compose passes to fibuki-web must be declared in web.Dockerfile.
 *
 * Docker silently discards a build arg the Dockerfile does not declare. For a
 * NEXT_PUBLIC_* value that is worse than an error: Next inlines `undefined` into
 * the client bundle at build time, the image builds clean, and the app runs with
 * a wrong absolute origin or a feature flag stuck at its default. NEXT_PUBLIC_APP_URL
 * was dropped this way for the whole life of the compose file (#54), and
 * NEXT_PUBLIC_GITHUB_SIGNIN_ENABLED alongside it.
 *
 * The reverse direction is checked too: an ARG the Dockerfile declares but compose
 * never passes builds with an empty value, which is the same silent hole seen from
 * the other end.
 *
 * Usage: node scripts/check-web-build-args.js
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const composePath = path.join(root, "deploy/selfhost/docker-compose.yml");
const dockerfilePath = path.join(root, "deploy/selfhost/web.Dockerfile");

const compose = fs.readFileSync(composePath, "utf-8");
const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");

/** The `args:` mapping under the fibuki-web service's `build:` block. */
function composeBuildArgs() {
  const lines = compose.split("\n");
  const serviceIdx = lines.findIndex((l) => /^ {2}fibuki-web:/.test(l));
  if (serviceIdx === -1) throw new Error("fibuki-web service not found in the compose file");

  const names = [];
  let inArgs = false;

  for (let i = serviceIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // Next top-level service ends the search.
    if (/^ {2}\S/.test(line)) break;
    if (/^ {6}args:\s*$/.test(line)) {
      inArgs = true;
      continue;
    }
    if (!inArgs) continue;
    // Anything back at the service's own indent ends the args mapping.
    if (/^ {4}\S/.test(line)) break;

    const match = line.match(/^ {8}([A-Z0-9_]+):/);
    if (match) names.push(match[1]);
  }

  return [...new Set(names)];
}

function dockerfileArgs() {
  return [...new Set([...dockerfile.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map((m) => m[1]))];
}

const passed = composeBuildArgs();
const declared = dockerfileArgs();

if (passed.length === 0) {
  console.error("No build args found under fibuki-web — the parser or the compose file moved.");
  process.exit(1);
}

const undeclared = passed.filter((n) => !declared.includes(n));
const unpassed = declared.filter((n) => !passed.includes(n));

for (const name of undeclared) {
  console.error(
    `::error::${name} is passed as a build arg by deploy/selfhost/docker-compose.yml but not declared in deploy/selfhost/web.Dockerfile — Docker discards it and the build sees an empty value.`
  );
}
for (const name of unpassed) {
  console.error(
    `::error::${name} is declared in deploy/selfhost/web.Dockerfile but never passed by deploy/selfhost/docker-compose.yml — it builds with an empty value.`
  );
}

if (undeclared.length || unpassed.length) process.exit(1);

console.log(`web build args in sync (${passed.length} checked)`);
