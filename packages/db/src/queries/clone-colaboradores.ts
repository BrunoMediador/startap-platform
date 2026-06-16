/**
 * clone-colaboradores — leitura do tipo de conta e dos colaboradores de um
 * estabelecimento (ADR 0023/0024, Fase A).
 *
 * Este módulo só é exercitado quando o caminho ESTABELECIMENTO está ligado
 * (flag ESTABELECIMENTO_ENABLED + product_type='estabelecimento'). O caminho
 * individual nunca importa daqui. A resolução de calendarId por colaborador
 * (com client GCal e isolamento de cache por tenant) vive no resolvedor
 * `getGcalsForSlot` em @startap/integrations — aqui ficam só leituras de metadado
 * que o caller (apps/api) precisa pra decidir o caminho e validar.
 */
import { query } from '../client.js';

/** Tipo de conta de um clone. Default no banco é 'individual' (migration 052). */
export type ProductType = 'individual' | 'estabelecimento';

/**
 * Lê o product_type de um slot. Retorna 'individual' como fallback seguro quando:
 *  - a coluna não existe ainda (migration 052 não aplicada neste ambiente);
 *  - o slot não tem linha em flow_clones (matriz/bot interno);
 *  - valor nulo/desconhecido.
 *
 * Fallback 'individual' é DELIBERADO: na dúvida, o caminho é o atual (nenhum
 * código novo é alcançado). Isso protege Cirilo/Samuel mesmo se a migration
 * ainda não tiver rodado — o bot nunca tenta o caminho estabelecimento por engano.
 *
 * Lê SÓ de flow_clones (estabelecimento é sempre 'clone_'); não consulta bot_config.
 */
export async function getProductType(slot: string): Promise<ProductType> {
  try {
    const r = await query<{ product_type: string | null }>(
      'SELECT product_type FROM flow_clones WHERE slot = $1 LIMIT 1',
      [slot],
    );
    const v = r.rows[0]?.product_type;
    return v === 'estabelecimento' ? 'estabelecimento' : 'individual';
  } catch {
    // Coluna ausente (pré-052) ou erro de query → fallback seguro pro caminho atual.
    return 'individual';
  }
}

/**
 * Lê a área/vertical de um slot (flow_clones.area, migration 051).
 *
 * Retorna `null` (NÃO uma string default) quando a coluna não existe, o slot não
 * tem linha em flow_clones, ou o valor é nulo — assim o chamador distingue "sem
 * área conhecida" de uma área concreta e aplica o fallback genérico DELE. A
 * normalização da taxonomia (barbearia/cabeleireiro/manicure/estetica/...) é
 * responsabilidade da camada de emojis (apps/api), não daqui — este reader só
 * devolve o texto cru do banco em lowercase, sem inventar default.
 *
 * Fallback `null` é DELIBERADO e seguro: o consumidor (cartão de confirmação)
 * trata null como "área desconhecida" → não muda emoji nenhum (caminho atual).
 */
export async function getArea(slot: string): Promise<string | null> {
  try {
    const r = await query<{ area: string | null }>(
      'SELECT area FROM flow_clones WHERE slot = $1 LIMIT 1',
      [slot],
    );
    const v = r.rows[0]?.area;
    return v ? v.trim().toLowerCase() : null;
  } catch {
    // Coluna ausente (pré-051) ou erro de query → null = área desconhecida.
    return null;
  }
}
