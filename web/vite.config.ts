import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: 'static',
    emptyOutDir: true
  }
});
