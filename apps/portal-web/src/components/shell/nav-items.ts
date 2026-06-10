/**
 * Itens de navegacao do portal (spec 6.13). Mesmos itens na bottom nav (mobile)
 * e na sidebar (>=md): Inicio, Servicos, Horarios, Pausas, Mensalidade.
 */
import { IconCalendar, IconHome, IconPause, IconServices, IconWallet } from '@/components/icons';

export interface NavItem {
  href: string;
  label: string;
  Icon: typeof IconHome;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/inicio', label: 'Início', Icon: IconHome },
  { href: '/servicos', label: 'Serviços', Icon: IconServices },
  { href: '/horarios', label: 'Horários', Icon: IconCalendar },
  { href: '/pausas', label: 'Pausas', Icon: IconPause },
  { href: '/mensalidade', label: 'Mensalidade', Icon: IconWallet },
];
