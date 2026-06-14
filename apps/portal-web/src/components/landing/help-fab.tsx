import { IconWhatsapp } from '@/components/icons';
import { AJUDA_WHATSAPP_URL } from '@/lib/suporte';
/**
 * FAB "Ajuda" flutuante (W12) — atalho persistente pro WhatsApp de suporte no
 * scroll da landing pública. Ação direta (abre wa.me com texto de visitante),
 * sem popover. Na landing NÃO há bottom-nav (essa é o shell logado), então o FAB
 * não colide. Vem por ÚLTIMO no DOM pra não roubar ordem de tab.
 *
 * Server component (link puro): reusa AJUDA_WHATSAPP_URL (número único de
 * suporte centralizado em lib/suporte.ts), sem número novo hardcoded.
 */

export function HelpFab() {
  return (
    <a
      href={AJUDA_WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Falar com a gente no WhatsApp"
      className="fixed bottom-5 right-5 z-40 inline-flex h-12 min-h-11 items-center gap-2 rounded-pill bg-brand px-4 font-display text-[14px] font-semibold text-bg shadow-[0_8px_22px_rgba(154,124,240,0.28)] outline-none transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:bottom-6 sm:right-6"
    >
      <IconWhatsapp size={20} />
      <span>Ajuda</span>
    </a>
  );
}
