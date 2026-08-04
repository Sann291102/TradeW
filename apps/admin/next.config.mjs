/** @type {import('next').NextConfig} */

/**
 * apps/admin's data path is deliberately different from apps/web's.
 *
 * apps/web proxies `/api/*` to services/api as a transparent same-origin
 * rewrite — the browser's own bearer token goes straight through. Admin
 * cannot do that: authorization here is the shared `ADMIN_API_TOKEN`
 * (`AdminTokenGuard`, `services/api/src/auth/admin-token.guard.ts`), and that
 * secret must never reach client-side JavaScript. So admin calls services/api
 * only from Next.js Route Handlers (`src/app/api/**\/route.ts`), which read the
 * admin session from an httpOnly cookie server-side and attach
 * `x-admin-token` themselves. There is no rewrite here for that reason — every
 * admin data route is a real server-side handler, not a forward.
 */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
