/**
 * Itens de navegacao do portal (spec 6.13). Mesmos itens na bottom nav (mobile)
 * e na sidebar (>=md): Inicio, Conectar, Servicos, Horarios, Pausas, Mensalidade.
 *
 * "Conectar" (2a posicao) e GATED pela feature de reconexao: so aparece quando
 * GET /portal/conexao responde `enabled:true` (gate `'conexao'` no array `gated`).
 * Quando visivel, ganha um badge-dot vermelho enquanto a sessao nao esta WORKING
 * — a regra de exibicao do dot vive no shell (sidebar/bottom-nav), que ja
 * consulta o estado da conexao. Itens com `gated` so aparecem quando TODOS os
 * gates do array passam (ver use-conexao-nav).
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
  /** Item GATED (pode combinar mais de um — TODOS precisam passar):
   *  - 'conexao'         -> só aparece com GET /portal/conexao.enabled true.
   *  - 'estabelecimento' -> só aparece quando product_type === 'estabelecimento'
   *    (vem da sessão /auth/me). Individual (Cirilo/Samuel) nunca vê.
   *  - 'atendimentos'    -> só aparece quando atendimentos_enabled (flag do backend).
   */
  gated?: ('conexao' | 'estabelecimento' | 'atendimentos')[];
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/inicio', label: 'Início', Icon: IconHome },
  { href: '/conectar', label: 'Conectar', Icon: IconWhatsapp, gated: ['conexao'] },
  { href: '/equipe', label: 'Equipe', Icon: IconUsers, gated: ['estabelecimento'] },
  // App de gestão (Fase 1): tela ÚNICA Billing (faturamento + comissão consolidados,
  // Previsão|Faturado). Substitui os itens separados Faturamento/Comissão/Registrar
  // — "Registrar" virou um botão DENTRO da tela Billing. Gated pela flag.
  { href: '/billing', label: 'Billing', Icon: IconWallet, gated: ['atendimentos'] },
  { href: '/servicos', label: 'Serviços', Icon: IconServices },
  { href: '/horarios', label: 'Horários', Icon: IconCalendar },
  { href: '/perfil', label: 'Meu negócio', Icon: IconUser },
  { href: '/pausas', label: 'Pausas', Icon: IconPause },
  { href: '/mensalidade', label: 'Mensalidade', Icon: IconWallet },
];
