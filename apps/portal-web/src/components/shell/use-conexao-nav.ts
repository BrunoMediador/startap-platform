'use client';

/**
 * Logica de navegacao GATED, compartilhada por sidebar e bottom-nav. Filtra
 * NAV_ITEMS pelos dois gates atuais:
 *   - gated:'conexao'        -> só aparece com a feature de reconexao ON
 *     (GET /portal/conexao.enabled true) E com o estado já carregado (evita
 *     piscar o item e sumir).
 *   - gated:'estabelecimento' -> só aparece quando o dono é estabelecimento
 *     (productType da sessao /auth/me, READ-only). Individual (Cirilo/Samuel) ->
 *     productType 'individual' -> item "Equipe" NUNCA renderiza (nav byte-a-byte).
 * Itens sem `gated` nunca filtram.
 *
 * `showDot(item)`: true só pro item "Conectar" quando a sessao NAO esta WORKING
 * (needs_action) — o badge-dot vermelho que chama a atencao.
 *
 * Fontes: useConexao (GET /portal/conexao, auto-refresh em foco) + productType da
 * sessao (server-fetched no guard, sem fetch extra). O nome do hook permanece
 * `useConexaoNav` por compat com sidebar/bottom-nav (que ja o consomem).
 */
import { useConexao } from '@/lib/queries';
import { NAV_ITEMS, type NavItem } from './nav-items';
import { useTenant } from './session-context';

export function useConexaoNav(): {
  visibleItems: NavItem[];
  showDot: (item: NavItem) => boolean;
} {
  const { slot, productType } = useTenant();
  const conexao = useConexao(slot);
  const enabled = conexao.data?.enabled === true;
  const needsAction = conexao.data?.needs_action === true;
  const isEstabelecimento = productType === 'estabelecimento';

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.gated === 'conexao') return enabled;
    if (item.gated === 'estabelecimento') return isEstabelecimento;
    return true;
  });

  const showDot = (item: NavItem) => item.gated === 'conexao' && enabled && needsAction;

  return { visibleItems, showDot };
}
