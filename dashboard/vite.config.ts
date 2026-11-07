import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // React gets its own chunk. Left to itself it lands in the charts chunk, and then every page downloads the chart library.
        manualChunks: (id) => (/node_modules[\/](react|react-dom|scheduler)[\/]/.test(id) ? 'react' : /node_modules[\/](recharts|d3-|victory-vendor)/.test(id) ? 'charts' : undefined),
      },
    },
  },
  // Dev and preview proxy to a running service, so a built dashboard can be checked without replacing the deployed one.
  server: { proxy: { '/api': process.env.RUNTRACE_API ?? 'http://127.0.0.1:4310', '/health': process.env.RUNTRACE_API ?? 'http://127.0.0.1:4310' } },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.{ts,tsx}'], restoreMocks: true },
});
