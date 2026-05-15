import pg from 'pg';
import { STARTAP_DEFAULT_PROMPT } from '/app/apps/api/dist/bots/startap.js';
import { TESTE_BARBEARIA_DEFAULT_PROMPT } from '/app/apps/api/dist/bots/teste_barbearia.js';
import { TESTE_VENDAS_DEFAULT_PROMPT } from '/app/apps/api/dist/bots/teste_vendas.js';
import { TESTE_VENDAS_BARBEARIA_DEFAULT_PROMPT } from '/app/apps/api/dist/bots/teste_vendas_barbearia.js';

const c = new pg.Client({
  host: 'postgres',
  user: 'startap_user',
  password: 'senha_banco_forte_123',
  database: 'startap_database',
});
await c.connect();

const prompts = [
  ['teste_barbearia', TESTE_BARBEARIA_DEFAULT_PROMPT],
  ['teste_vendas', TESTE_VENDAS_DEFAULT_PROMPT],
  ['teste_vendas_barbearia', TESTE_VENDAS_BARBEARIA_DEFAULT_PROMPT],
  ['startap', STARTAP_DEFAULT_PROMPT],
];

for (const [slot, prompt] of prompts) {
  await c.query(
    'INSERT INTO bot_prompt (slot, prompt) VALUES ($1, $2) ON CONFLICT (slot) DO NOTHING',
    [slot, prompt],
  );
  console.log('seeded', slot, prompt.length, 'chars');
}

await c.end();
