'use client';

/**
 * Logica de navegacao da feature de conexao, compartilhada por sidebar e
 * bottom-nav:
 *   - `visibleItems`: NAV_ITEMS com o item gated ("Conectar") filtrado quando a
 *     feature esta OFF (enabled:false) OU enquanto o estado da conexao ainda
 *     carrega (evita piscar o item e sumir). Os demais itens nunca filtram.
 *   - `showDot(item)`: true so pro item "Conectar" quando a sessao NAO esta
 *     WORKING (needs_action) — o badge-dot vermelho que chama a atencao.
 *
 * Fonte unica: useConexao (GET /portal/conexao), que ja faz auto-refresh em foco
 * — o item/dot reagem quando o WhatsApp cai ou volta mesmo fora da tela.
 */
import { useConexao } from '@/lib/queries';
import { NAV_ITEMS, type NavItem } from './nav-items';
import { useTenant } from './session-context';

export function useConexaoNav(): {
  visibleItems: NavItem[];
  showDot: (item: NavItem) => boolean;
} {
  const { slot } = useTenant();
  const conexao = useConexao(slot);
  const enabled = conexao.data?.enabled === true;
  const needsAction = conexao.data?.needs_action === true;

  const visibleItems = NAV_ITEMS.filter((item) => item.gated !== 'conexao' || enabled);

  const showDot = (item: NavItem) => item.gated === 'conexao' && enabled && needsAction;

  return { visibleItems, showDot };
}
