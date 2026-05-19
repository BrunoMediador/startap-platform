import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // .claude/worktrees contem copias stale dos testes de agents — excluir evita 69 falhas fantasma.
    // painel-admin/test usa node:test (nao vitest) — rodar via: node --test painel-admin/test/*.test.js
    exclude: [
      '**/.claude/**',
      '**/node_modules/**',
      '**/dist/**',
      'painel-admin/test/**',
    ],
  },
});
