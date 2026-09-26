import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    // Everything as files: the CSP allows no inline scripts or styles.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5174,
    proxy: { '/api/': 'http://localhost:8080' },
  },
});
