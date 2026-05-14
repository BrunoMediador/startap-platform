import { query } from '../client.js';

export interface LeadRicardo {
  id?: number;
  nome: string | null;
  telefone: string;
  mensagem_inicial?: string | null;
  origem?: string | null;
  criado_em?: Date;
}

export async function saveLeadRicardo(input: LeadRicardo): Promise<void> {
  await query(
    `INSERT INTO leads_ricardo (nome, telefone, mensagem_inicial, origem, criado_em)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT DO NOTHING`,
    [input.nome, input.telefone, input.mensagem_inicial ?? null, input.origem ?? null],
  );
}
