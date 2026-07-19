/**
 * @tradew/ui — shared design-system package.
 *
 * Tokens live in ./styles/tokens.css (import once at the app root) and the
 * matching Tailwind theme in ./tailwind-preset (add to the app's tailwind
 * config presets). This barrel re-exports the runtime pieces: components,
 * motion variants, and the cn() helper.
 */
export * from './components';
export * from './motion/variants';
export { cn } from './lib/cn';
