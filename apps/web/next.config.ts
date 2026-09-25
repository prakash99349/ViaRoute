import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (see apps/web/Dockerfile).
  output: "standalone",
  // pnpm keeps packages at the monorepo root, so trace files from there.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Keep the dev badge away from the sidebar's "Log out" button.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
