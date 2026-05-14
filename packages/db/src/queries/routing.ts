import { query } from '../client.js';

export interface RoutingRow {
  id: number;
  telefone: string;
  workflow_id: string;
  workflow_name: string;
  webhook_url: string | null;
  nome_cliente: string | null;
  ativo: boolean;
  criado_em: Date;
  atualizado_em: Date;
}

/** Busca a rota ativa para um telefone. Retorna null se não existe. */
export async function findRouting(telefone: string): Promise<RoutingRow | null> {
  const r = await query<RoutingRow>(
    `SELECT id, telefone, workflow_id, workflow_name, webhook_url, nome_cliente, ativo,
            criado_em, atualizado_em
     FROM routing_clientes
     WHERE telefone = $1 AND ativo = TRUE
     LIMIT 1`,
    [telefone],
  );
  return r.rows[0] ?? null;
}

export async function listRouting(): Promise<RoutingRow[]> {
  const r = await query<RoutingRow>(
    `SELECT id, telefone, workflow_id, workflow_name, webhook_url, nome_cliente, ativo,
            criado_em, atualizado_em
     FROM routing_clientes
     ORDER BY workflow_name, telefone`,
  );
  return r.rows;
}

/** Insere ou atualiza um vínculo telefone → bot. UNIQUE em telefone garante 1 fluxo por número. */
export async function upsertRouting(input: {
  telefone: string;
  workflow_id: string;
  workflow_name: string;
  webhook_url: string;
  nome_cliente: string | null;
  ativo: boolean;
}): Promise<void> {
  await query(
    `INSERT INTO routing_clientes
       (telefone, workflow_id, workflow_name, webhook_url, nome_cliente, ativo, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (telefone) DO UPDATE SET
       workflow_id = EXCLUDED.workflow_id,
       workflow_name = EXCLUDED.workflow_name,
       webhook_url = EXCLUDED.webhook_url,
       nome_cliente = COALESCE(EXCLUDED.nome_cliente, routing_clientes.nome_cliente),
       ativo = EXCLUDED.ativo,
       atualizado_em = NOW()`,
    [
      input.telefone,
      input.workflow_id,
      input.workflow_name,
      input.webhook_url,
      input.nome_cliente,
      input.ativo,
    ],
  );
}

export async function deleteRouting(id: number): Promise<void> {
  await query('DELETE FROM routing_clientes WHERE id = $1', [id]);
}
