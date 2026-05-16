import { query } from '../client.js';

export interface LeadRicardo {
  id?: number;
  nome: string | null;
  telefone: string;
  mensagem_inicial?: string | null;
  origem?: string | null;
  slot: string;
  criado_em?: Date;
}

export async function saveLeadRicardo(input: LeadRicardo): Promise<void> {
  await query(
    `INSERT INTO leads_ricardo (nome, telefone, mensagem_inicial, origem, slot, criado_em)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT DO NOTHING`,
    [input.nome, input.telefone, input.mensagem_inicial ?? null, input.origem ?? null, input.slot],
  );
}

export async function saveLeadVendasBarbearia(input: LeadRicardo): Promise<void> {
  await query(
    `INSERT INTO leads_vendas_barbearia (nome, telefone, mensagem_inicial, origem, slot, criado_em)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT DO NOTHING`,
    [input.nome, input.telefone, input.mensagem_inicial ?? null, input.origem ?? null, input.slot],
  );
}

export async function listLeadsRicardo(slot?: string): Promise<unknown[]> {
  if (slot) {
    const r = await query(
      `SELECT * FROM leads_ricardo WHERE slot = $1 ORDER BY id DESC LIMIT 200`,
      [slot],
    );
    return r.rows;
  }
  const r = await query(`SELECT * FROM leads_ricardo ORDER BY id DESC LIMIT 200`, []);
  return r.rows;
}

export async function listLeadsVendasBarbearia(slot?: string): Promise<unknown[]> {
  if (slot) {
    const r = await query(
      `SELECT * FROM leads_vendas_barbearia WHERE slot = $1 ORDER BY id DESC LIMIT 200`,
      [slot],
    );
    return r.rows;
  }
  const r = await query(`SELECT * FROM leads_vendas_barbearia ORDER BY id DESC LIMIT 200`, []);
  return r.rows;
}
