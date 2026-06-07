/**
 * Itens de navegacao do portal (spec 6.13). Mesmos 4 itens na bottom nav (mobile)
 * e na sidebar (>=md): Inicio, Servicos, Horarios, Pausas.
 */
import { IconCalendar, IconHome, IconPause, IconServices } from '@/components/icons';

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
];
