/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['pg', 'kysely', 'bcryptjs'],
  eslint: { ignoreDuringBuilds: true },
  // The sandbox/VPS preview is served through a proxy host, so allow it.
  allowedDevOrigins: ['*.e2b.app', 'localhost', '127.0.0.1'],
  experimental: {
    serverActions: { allowedOrigins: ['*'] },
  },
};

export default nextConfig;
