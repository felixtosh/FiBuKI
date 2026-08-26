#!/usr/bin/env node

/**
 * Refuse anchors that point at one operator's private documents.
 *
 * Both repositories are public. Test fixtures were written against a real
 * bookkeeping corpus, and the fastest way to write one is to name the document
 * it came from: `paperless-ap-1004`, `IV-26-1170`, `FIBU_20260109-8624`. Those
 * identifiers resolve to nothing for a reader — they are only meaningful
 * inside the self-hosted instance they were copied from, which is exactly what
 * makes them a leak rather than documentation.
 *
 * The fix is never to delete the case. A test that encodes a real defect is
 * the most valuable kind there is. It is to describe the document instead of
 * naming it: `f-insurance-11pct` says what the fixture IS, and survives the
 * corpus it came from.
 *
 * Runs before `npm ci` in CI, like `check-web-build-args.js`, so it fails in
 * seconds and needs no dependencies.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

/**
 * Tracked files only, via `git ls-files`.
 *
 * What is published is what is committed, so that is the set to police. It
 * also keeps the guard out of build output, out of `node_modules`, and out of
 * the scratch worktrees that live under `.claude/` — a stale copy of an old
 * branch is not a leak, and failing CI over one would train people to ignore
 * this check.
 */
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".json"]);

/** Generated from a scanned source, so a finding there is a duplicate. */
const SKIP_PREFIXES = ["functions/lib/", "lib/data/generated-"];

/**
 * Each pattern is built at runtime rather than written as a literal, so this
 * file does not trip its own check — which would be the fastest possible way
 * for the guard to be deleted rather than obeyed.
 */
const FORBIDDEN = [
  {
    name: "Paperless document id",
    pattern: new RegExp(["paperless", "ap", "\\d{2,}"].join("-"), "i"),
    fix: "name the fixture for what it is — f-insurance-11pct, f-multi-rate-meal",
  },
  {
    name: "outgoing invoice number",
    pattern: new RegExp(["IV", "\\d{2}", "1\\d{3}"].join("-")),
    fix: "use an obviously invented number (IV-25-0042) or describe the document",
  },
  {
    name: "FiBu document reference",
    pattern: new RegExp(["FIBU", "\\d{8}"].join("_")),
    fix: "describe the document instead — f-discount-to-zero",
  },
  {
    name: "private research path",
    pattern: /finance\/uva-research/,
    fix: "cite the rule or the statute, not a path on one machine",
  },
];

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  return output
    .split("\0")
    .filter(Boolean)
    .filter((file) => SCAN_EXTENSIONS.has(path.extname(file)))
    .filter((file) => !SKIP_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .map((file) => path.join(ROOT, file));
}

function main() {
  const self = path.join(ROOT, "scripts", "check-corpus-anchors.js");
  const findings = [];

  for (const file of trackedFiles()) {
    if (file === self) continue;
    if (!fs.existsSync(file)) continue; // staged deletion, nothing to read

    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(line)) {
          findings.push({
            file: path.relative(ROOT, file),
            line: index + 1,
            rule,
            text: line.trim().slice(0, 100),
          });
        }
      }
    });
  }

  if (findings.length === 0) {
    console.log("No corpus anchors found.");
    return;
  }

  console.error(
    `\nFound ${findings.length} reference(s) to documents that exist only in one private instance.\n` +
      "Both repos are public, so these have to describe the document rather than name it.\n"
  );
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  (${finding.rule.name})`);
    console.error(`    ${finding.text}`);
    console.error(`    fix: ${finding.rule.fix}\n`);
  }
  process.exit(1);
}

main();
