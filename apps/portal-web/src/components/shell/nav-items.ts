/**
 * Itens de navegacao do portal (spec 6.13). Mesmos itens na bottom nav (mobile)
 * e na sidebar (>=md): Inicio, Conectar, Servicos, Horarios, Pausas, Mensalidade.
 *
 * "Conectar" (2a posicao) e GATED pela feature de reconexao: so aparece quando
 * GET /portal/conexao responde `enabled:true` (campo `gated:'conexao'`). Quando
 * visivel, ganha um badge-dot vermelho enquanto a sessao nao esta WORKING — a
 * regra de exibicao do dot vive no shell (sidebar/bottom-nav), que ja consulta
 * o estado da conexao.
 */
import {
  IconCalendar,
  IconHome,
  IconPause,
  IconServices,
  IconUser,
  IconUsers,
  IconWallet,
  IconWhatsapp,
} from '@/components/icons';

export interface NavItem {
  href: string;
  label: string;
  Icon: typeof IconHome;
  /** Item GATED:
   *  - 'conexao'        -> só aparece com GET /portal/conexao.enabled true.
   *  - 'estabelecimento' -> só aparece quando product_type === 'estabelecimento'
   *    (vem da sessão /auth/me). Individual (Cirilo/Samuel) nunca vê.
   */
  gated?: 'conexao' | 'estabelecimento';
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/inicio', label: 'Início', Icon: IconHome },
  { href: '/conectar', label: 'Conectar', Icon: IconWhatsapp, gated: 'conexao' },
  { href: '/equipe', label: 'Equipe', Icon: IconUsers, gated: 'estabelecimento' },
  { href: '/servicos', label: 'Serviços', Icon: IconServices },
  { href: '/horarios', label: 'Horários', Icon: IconCalendar },
  { href: '/perfil', label: 'Meu negócio', Icon: IconUser },
  { href: '/pausas', label: 'Pausas', Icon: IconPause },
  { href: '/mensalidade', label: 'Mensalidade', Icon: IconWallet },
];
