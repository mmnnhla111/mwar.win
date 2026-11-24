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
      fontFamily: {
        // Latin + Vietnamese: Plus Jakarta Sans; Thai: Prompt / Noto Sans Thai (Google Fonts only downloads the
        // Thai subset when Thai text is on screen); CJK + Devanagari fall back to the device's own fonts.
        sans: [
          '"Plus Jakarta Sans"',
          'Prompt',
          '"Noto Sans Thai"',
          '"Noto Sans SC"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Hiragino Sans"',
          '"Noto Sans JP"',
          '"Apple SD Gothic Neo"',
          '"Malgun Gothic"',
          '"Noto Sans KR"',
          '"Noto Sans Devanagari"',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
      },
      colors: {
        cream: '#FAF9F5',
        ink: '#1C1917',
        lemon: { DEFAULT: '#FFE135', 400: '#FACC15', 100: '#FFF6C2', 50: '#FFFBEA' },
        mint: { DEFAULT: '#34D399', 100: '#D1FAE5' },
        coral: { DEFAULT: '#FF6B6B', 100: '#FFE4E6' },
        skyp: '#E0F2FE',
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
