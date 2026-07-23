'use client';

/**
 * Logica de navegacao GATED, compartilhada por sidebar e bottom-nav. Cada item
 * pode ter VÁRIOS gates (`gated` é um array) — TODOS precisam passar pra aparecer:
 *   - 'conexao'        -> só com a feature de reconexao ON (GET /portal/conexao.
 *     enabled true) E com o estado já carregado (evita piscar o item e sumir).
 *   - 'estabelecimento' -> só quando o dono é estabelecimento (productType da
 *     sessao /auth/me, READ-only). Individual (Cirilo/Samuel) nunca vê "Equipe".
 *   - 'atendimentos'   -> só quando o app de gestão está ligado pro cliente
 *     (atendimentosEnabled da sessao). "Comissão" combina atendimentos+estabelecimento.
 * Itens sem `gated` nunca filtram.
 *
 * `showDot(item)`: true só pro item "Conectar" quando a sessao NAO esta WORKING
 * (needs_action) — o badge-dot vermelho que chama a atencao.
 *
 * Fontes: useConexao (GET /portal/conexao, auto-refresh em foco) + productType da
 * sessao (server-fetched no guard, sem fetch extra). O nome do hook permanece
 * `useConexaoNav` por compat com sidebar/bottom-nav (que ja o consomem).
 */
import { filterByGates } from '@/lib/nav';
import { useConexao } from '@/lib/queries';
import { NAV_ITEMS, type NavItem } from './nav-items';
import { useTenant } from './session-context';

export function useConexaoNav(): {
  visibleItems: NavItem[];
  showDot: (item: NavItem) => boolean;
} {
  const { slot, productType, atendimentosEnabled } = useTenant();
  const conexao = useConexao(slot);
  const enabled = conexao.data?.enabled === true;
  const needsAction = conexao.data?.needs_action === true;
  const isEstabelecimento = productType === 'estabelecimento';

  // Fonte única da regra de gate vive em @/lib/nav (mesma usada no teste puro).
  const visibleItems = filterByGates(NAV_ITEMS, {
    conexaoEnabled: enabled,
    isEstabelecimento,
    atendimentosEnabled,
  });

  const showDot = (item: NavItem) =>
    item.gated?.includes('conexao') === true && enabled && needsAction;

  return { visibleItems, showDot };
}
