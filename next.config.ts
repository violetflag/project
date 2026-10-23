import fs from "fs";
import type { NextConfig } from "next";

// Static export so the app can be served from GitHub Pages.
// BASE_PATH is set to "/<repo>" when building for Pages.
// BUILD_ID lets an open tab notice that a newer version was deployed (see components/AppWatch.tsx).
const BUILD_ID = Date.now().toString(36);
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/version.json", JSON.stringify({ build: BUILD_ID }));

const nextConfig: NextConfig = {
  output: "export",
  basePath: process.env.BASE_PATH || "",
  env: { NEXT_PUBLIC_BASE_PATH: process.env.BASE_PATH || "", NEXT_PUBLIC_BUILD_ID: BUILD_ID },
  trailingSlash: true,
  images: { unoptimized: true },
  // Readable stack traces when something breaks in the browser.
  productionBrowserSourceMaps: true,
};

export default nextConfig;
