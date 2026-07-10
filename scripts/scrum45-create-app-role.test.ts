import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guarda de segurança do script SCRUM-45: valida o CONTEÚDO do SQL sem tocar em banco.
// Objetivo: impedir que uma edição futura reintroduza privilégio perigoso ou quebre um
// grant necessário. Não substitui o smoke E2E do runbook (que roda contra o Postgres).
const SQL = readFileSync(
  fileURLToPath(new URL('./scrum45-create-app-role.sql', import.meta.url)),
  'utf8',
);

// Comentários (linhas iniciando com --) descrevem privilégios NÃO usados; para não gerar
// falso-positivo nas asserções de "sem privilégio perigoso", checamos só o SQL executável.
const EXEC = SQL.split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

describe('scrum45-create-app-role.sql — caminho feliz (grants mínimos presentes)', () => {
  it('cria o role de runtime startap_app com LOGIN', () => {
    expect(EXEC).toMatch(/CREATE ROLE startap_app WITH[\s\S]*?LOGIN/);
  });

  it("usa a senha via placeholder :'app_pw' (nunca hardcoded)", () => {
    expect(EXEC).toContain("PASSWORD :'app_pw'");
    // Nenhum literal de senha entre aspas simples logo após PASSWORD.
    expect(EXEC).not.toMatch(/PASSWORD\s+'[^']/i);
  });

  it('concede CRUD em todas as tabelas de public', () => {
    expect(EXEC).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON ALL TABLES\s+IN SCHEMA public TO startap_app/,
    );
  });

  it('concede USAGE/SELECT nas sequences (INSERT em SERIAL/BIGSERIAL)', () => {
    expect(EXEC).toMatch(/GRANT USAGE, SELECT\s+ON ALL SEQUENCES IN SCHEMA public TO startap_app/);
  });

  it('concede USAGE no schema e CONNECT no banco', () => {
    expect(EXEC).toMatch(/GRANT USAGE ON SCHEMA public TO startap_app/);
    expect(EXEC).toMatch(/GRANT CONNECT ON DATABASE :"pgdb" TO startap_app/);
  });

  it('configura DEFAULT PRIVILEGES para os DOIS donos (tabelas e sequences)', () => {
    for (const owner of ['startap_user', 'startap_cluster_admin']) {
      expect(EXEC).toMatch(
        new RegExp(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner}[\\s\\S]*?GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES[\\s\\S]*?TO startap_app`,
        ),
      );
      expect(EXEC).toMatch(
        new RegExp(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner}[\\s\\S]*?GRANT USAGE, SELECT[\\s\\S]*?ON SEQUENCES[\\s\\S]*?TO startap_app`,
        ),
      );
    }
  });
});

describe('scrum45-create-app-role.sql — erro/guarda (nenhum privilégio perigoso)', () => {
  it('nega explicitamente SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS/REPLICATION no role', () => {
    for (const attr of [
      'NOSUPERUSER',
      'NOCREATEDB',
      'NOCREATEROLE',
      'NOBYPASSRLS',
      'NOREPLICATION',
    ]) {
      expect(EXEC).toContain(attr);
    }
  });

  it('NUNCA concede um atributo perigoso na forma positiva', () => {
    // \bSUPERUSER\b sem "NO" na frente etc. A negativa (NOSUPERUSER) não casa por causa do \b.
    for (const attr of ['SUPERUSER', 'CREATEDB', 'CREATEROLE', 'BYPASSRLS']) {
      expect(EXEC).not.toMatch(new RegExp(`(?<!NO)\\b${attr}\\b`));
    }
  });

  it('não contém DDL/DML destrutivo (DROP/TRUNCATE/DELETE FROM) no caminho de aplicação', () => {
    // O bloco de ROLLBACK vive em comentários (removido em EXEC); o executável é aditivo.
    expect(EXEC).not.toMatch(/\bDROP\b/i);
    expect(EXEC).not.toMatch(/\bTRUNCATE\b/i);
    expect(EXEC).not.toMatch(/\bREVOKE\b/i);
    expect(EXEC).not.toMatch(/DELETE FROM/i);
  });

  it('não vive em packages/db/migrations (não pode ser auto-aplicado pelo migrate.sh)', () => {
    const path = fileURLToPath(new URL('./scrum45-create-app-role.sql', import.meta.url));
    expect(path).not.toContain('/migrations/');
    expect(path).toContain('/scripts/');
  });
});
