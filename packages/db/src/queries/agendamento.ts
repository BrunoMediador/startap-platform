import { query } from '../client.js';

export interface AgendamentoPendente {
  id?: number;
  telefone: string;
  servico: string;
  data: string; // ISO date
  hora: string; // HH:mm
  duracao_min: number;
  criado_em?: Date;
}

export async function savePendente(input: AgendamentoPendente): Promise<void> {
  await query(
    `INSERT INTO agendamento_pendente (telefone, servico, data, hora, duracao_min, criado_em)
     VALUES ($1,$2,$3,$4,$5,NOW())`,
    [input.telefone, input.servico, input.data, input.hora, input.duracao_min],
  );
}

export async function findPendente(telefone: string): Promise<AgendamentoPendente | null> {
  const r = await query<AgendamentoPendente>(
    `SELECT * FROM agendamento_pendente WHERE telefone = $1
     ORDER BY criado_em DESC LIMIT 1`,
    [telefone],
  );
  return r.rows[0] ?? null;
}

export async function deletePendente(telefone: string): Promise<void> {
  await query('DELETE FROM agendamento_pendente WHERE telefone = $1', [telefone]);
}
