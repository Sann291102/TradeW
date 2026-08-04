import type { Config } from 'tailwindcss';
import tradewPreset from '@tradew/ui/tailwind-preset';

// Same preset apps/web uses — one design system, not a re-interpretation for
// the ops console.
const config: Config = {
  presets: [tradewPreset as Partial<Config>],
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
export default config;
