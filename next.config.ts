import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async redirects() {
    return [
      // Agent/API docs moved to top-level /agents ("For AI agents").
      { source: "/developers", destination: "/agents", permanent: true },
    ];
  },
};

export default nextConfig;
