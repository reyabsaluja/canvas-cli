#!/usr/bin/env node

// This wrapper uses CommonJS-compatible syntax (no ESM, no top-level await)
// so it can run on Node.js 14+ to provide a helpful error message.

var nodeVersion = process.versions.node;
var major = parseInt(nodeVersion.split(".")[0], 10);

if (major < 20) {
  console.error(
    "canvas-cli requires Node.js 20 or later. You're running " +
      nodeVersion +
      ". Please upgrade: https://nodejs.org"
  );
  process.exit(1);
}

import("../dist/cli.js");
