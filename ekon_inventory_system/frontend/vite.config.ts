import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The frontend builds straight into `backend/public`, and the backend serves it.
 * One origin, one deploy, one certificate — no CORS and no cookie-domain
 * problems.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../backend/public',
    emptyOutDir: true,
    // The shop is on an unreliable connection in Haiti. Keep the first paint
    // cheap and let the build fail loudly if a dependency blows the budget.
    chunkSizeWarningLimit: 250,
    sourcemap: true,
    rollupOptions: {
      output: {
        // Framework code changes far less often than application code. Splitting
        // it out means a deploy re-downloads only what actually changed, which
        // matters on the shop's connection.
        manualChunks: (id: string) =>
          /node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? 'vendor' : undefined,
      },
    },
  },
  server: {
    port: 5173,
    // In development the API lives on the backend's port; in production it is
    // the same origin, so application code always calls a relative /api path.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
  },
});
