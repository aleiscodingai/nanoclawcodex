import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['.codex/skills/**/tests/*.test.ts'],
  },
});
