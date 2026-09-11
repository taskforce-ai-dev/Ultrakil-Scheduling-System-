import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  typescript: {
    // A production build type-checks the product, not the test suite. Tests
    // legitimately reach across the workspace — the contract agreement test
    // reads the API's own conflict-group catalogue — but the release image
    // only ever copies this app and the generated contract, so type-checking
    // those files here would fail the image build on an import that is correct
    // everywhere it actually runs. `pnpm typecheck` still covers them.
    tsconfigPath: "./tsconfig.build.json",
  },
};

export default nextConfig;
