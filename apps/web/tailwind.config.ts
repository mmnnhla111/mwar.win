import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/game/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0a0d14',
        surface: '#111726',
        surfaceLight: '#1b2438',
        primary: {
          DEFAULT: '#e63946',
          hover: '#d62828',
          light: '#f1faee',
        },
        accent: {
          gold: '#ffd166',
          green: '#06d6a0',
          cyan: '#118ab2',
        },
      },
    },
  },
  plugins: [],
};

export default config;
