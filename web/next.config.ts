import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  async rewrites() {
    return [{ source: "/favicon.ico", destination: "/favicon.svg" }];
  },
};

export default nextConfig;
