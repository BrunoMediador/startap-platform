/**
 * Itens de navegacao do portal (spec 6.13). Mesmos itens na bottom nav (mobile)
 * e na sidebar (>=md). A ORDEM, os GATES e a chave de ícone vivem na spec PURA
 * `@/lib/nav` (testável no harness pure-fn); aqui só mapeamos a chave de ícone
 * -> componente SVG e derivamos os NavItem com o componente pronto.
 *
 * "Agenda" (2a posicao) e uma entrada FIXA da agenda de compromissos (antes so
 * alcancavel rolando a Home). "Conectar" e GATED pela feature de reconexao: so
 * aparece quando GET /portal/conexao responde `enabled:true`. Quando visivel,
 * ganha um badge-dot vermelho enquanto a sessao nao esta WORKING — a regra do
 * dot vive no shell (sidebar/bottom-nav). Itens com `gated` so aparecem quando
 * TODOS os gates passam (ver use-conexao-nav).
 */
import {
  IconCalendar,
  IconClock,
  IconHome,
  IconPause,
  IconServices,
  IconUser,
  IconUsers,
  IconWallet,
  IconWhatsapp,
} from '@/components/icons';
import { NAV_SPEC, type NavGate, type NavIconKey } from '@/lib/nav';

const ICONS: Record<NavIconKey, typeof IconHome> = {
  home: IconHome,
  calendar: IconCalendar,
  whatsapp: IconWhatsapp,
  users: IconUsers,
  wallet: IconWallet,
  services: IconServices,
  clock: IconClock,
  user: IconUser,
  pause: IconPause,
};

export interface NavItem {
  href: string;
  label: string;
  Icon: typeof IconHome;
  gated?: NavGate[];
}

export const NAV_ITEMS: NavItem[] = NAV_SPEC.map((spec) => ({
  href: spec.href,
  label: spec.label,
  Icon: ICONS[spec.icon],
  gated: spec.gated,
}));
