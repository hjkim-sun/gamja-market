import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/features/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        potato: {
          50: '#fff9eb',
          100: '#ffefc6',
          200: '#ffdc88',
          300: '#ffc34a',
          400: '#f5a623',
          500: '#dc8510',
          600: '#b9610b',
          700: '#94450f',
          800: '#793713',
          900: '#653016'
        },
        leaf: {
          50: '#effcf4',
          100: '#d9f7e5',
          500: '#20a460',
          600: '#16834b',
          700: '#14683e'
        }
      },
      boxShadow: {
        card: '0 10px 30px -18px rgba(68, 51, 30, 0.35)',
      },
    },
  },
  plugins: [],
};

export default config;
