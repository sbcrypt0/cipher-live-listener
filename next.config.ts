import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  logging: {
    // Don't copy the browser's console into the terminal or into
    // .next/dev/logs/next-development.log. The console can contain what
    // people said, and Cipher shouldn't store conversations anywhere.
    browserToTerminal: false,
  },
};

export default nextConfig;
