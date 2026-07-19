/** @type {import('next').NextConfig} */
const nextConfig = {
  // Consume the shared design-system package directly from TS source — no
  // separate build step for @tradew/ui (ARCHITECTURE.md packages/ui).
  transpilePackages: ['@tradew/ui'],
};
export default nextConfig;
