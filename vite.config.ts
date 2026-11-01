import { defineConfig } from 'vite';

// Relative asset paths so the built site works from any folder (GitHub Pages serves it under /halflife/).
export default defineConfig({
  base: './',
});
