/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#141413', paper: '#f4f1e8', muted: '#a8a49a', accent: '#d97757', panel: '#1d1c1a', line: '#34312d'
      },
      fontFamily: { sans: ['"IBM Plex Sans"', '"Segoe UI"', 'Arial', 'sans-serif'], mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'] },
      boxShadow: { panel: '0 18px 50px rgba(0,0,0,.22)' },
    },
  },
  plugins: [],
}
