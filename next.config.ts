import type { NextConfig } from "next";

// Static export so the app can be served from GitHub Pages.
// BASE_PATH is set to "/<repo>" when building for Pages.
const nextConfig: NextConfig = {
  output: "export",
  basePath: process.env.BASE_PATH || "",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
