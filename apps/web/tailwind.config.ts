import type { Config } from 'tailwindcss';
import tradewPreset from '@tradew/ui/tailwind-preset';

const config: Config = {
  // Shared design tokens (colors, fonts, motion) come from the @tradew/ui preset
  // so every app renders the same system rather than a re-interpretation.
  presets: [tradewPreset as Partial<Config>],
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    // scan the shared UI package so its component classes are emitted
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: { extend: {} },
  plugins: [],
};
export default config;
