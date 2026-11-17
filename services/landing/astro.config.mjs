import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://thewired.app',
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
  },
  server: {
    port: 4321,
  },
});
