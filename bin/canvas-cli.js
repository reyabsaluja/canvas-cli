#!/usr/bin/env node

// This wrapper uses CommonJS-compatible syntax (no ESM, no top-level await)
// so it can run on Node.js 14+ to provide a helpful error message.

var nodeVersion = process.versions.node;
var parts = nodeVersion.split(".");
var major = parseInt(parts[0], 10);
var minor = parseInt(parts[1], 10);

// Matches "engines" in package.json: import attributes (with { type: "json" })
// need Node.js 20.10.
if (major < 20 || (major === 20 && minor < 10)) {
  console.error(
    "canvas-cli requires Node.js 20.10 or later. You're running " +
      nodeVersion +
      ". Please upgrade: https://nodejs.org"
  );
  process.exit(1);
}

import("../dist/cli.js").catch(function (err) {
  console.error(err);
  process.exit(1);
});
