import type { NextConfig } from "next";

// Served from GitHub Pages at https://reyabsaluja.github.io/canvas-cli/, so
// every route and asset lives under /canvas-cli. `next dev` serves the same
// prefix so links behave identically locally.
const basePath = process.env.SITE_BASE_PATH ?? "/canvas-cli";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
