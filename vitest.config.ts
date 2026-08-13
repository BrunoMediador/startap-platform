import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // Worktrees contem copias stale dos testes de agents — excluir evita falhas fantasma.
    // painel-admin/test usa node:test e tem gate proprio no CI: npm run test:panel.
    exclude: [
      '**/.claude/**',
      '**/.codex/**',
      '**/.worktrees/**',
      '**/node_modules/**',
      '**/dist/**',
      'painel-admin/test/**',
    ],
  },
});
