/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  experimental: {
    instrumentationHook: true,
  },
  // Include ws module in standalone build (used by relay WebSocket server)
  serverExternalPackages: ['ws'],
};

module.exports = nextConfig;
