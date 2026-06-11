'use client';

/**
 * Banner de reconexao self-service. Aparece no topo de TODAS as rotas do app
 * quando o WhatsApp do robo precisa de acao (GET /portal/conexao -> needs_action),
 * e some quando volta a WORKING. Mesmo padrao visual do SuspendedNotice, mas com
 * CTA ativo: "Reconectar agora" leva pra /conectar JA disparando a reconexao
 * (a tela le `?auto=1` e entra direto no estado "reiniciando").
 *
 * Gated pela flag: so renderiza com `enabled:true`. Some na propria /conectar
 * (la o fluxo ja esta na tela — banner seria redundante).
 */
import { IconWhatsapp } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { useConexao } from '@/lib/queries';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function ReconnectBanner() {
  const { slot } = useTenant();
  const pathname = usePathname();
  const conexao = useConexao(slot);
  const data = conexao.data;

  // Gate + estado: so com a flag ON, precisando de acao, e fora da /conectar.
  if (!data?.enabled || !data.needs_action || pathname === '/conectar') return null;

  return (
    <div role="status" className="border-b border-danger/30 bg-danger-soft px-5 py-3">
      <div className="mx-auto flex w-full max-w-[720px] items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger">
          <IconWhatsapp size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-[13.5px] font-semibold leading-tight text-ink">
            Seu WhatsApp se desconectou
          </p>
          <p className="mt-0.5 text-[12.5px] leading-tight text-ink-soft">
            O robô parou de atender. Reconecte pra voltar ao ar.
          </p>
        </div>
        <Link
          href="/conectar?auto=1"
          className="inline-flex h-9 shrink-0 items-center rounded-btn bg-brand px-3.5 font-display text-[13px] font-semibold text-bg outline-none transition-colors hover:bg-brand-600 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          Reconectar agora
        </Link>
      </div>
    </div>
  );
}
