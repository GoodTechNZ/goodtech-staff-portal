import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'] },
} as any);
