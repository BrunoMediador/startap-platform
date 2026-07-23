'use client';

/**
 * Guia de primeiros passos / checklist de ativação da Home (SCRUM-96).
 *
 * ADITIVO: renderiza logo abaixo da hero-zone SÓ quando há passo pendente. Some
 * inteiro (return null) quando tudo está pronto — o cliente já configurado
 * (Cirilo/Samuel/Ingrid/Meduzza) não vê NADA novo (Home byte-idêntica). Toda a
 * decisão vive em lib/guia-ativacao (pura, testada); aqui é só o transporte dos
 * hooks existentes → sinais → render. Reusa card/estilo do design system.
 *
 * FAIL-CLOSED: enquanto os 3 GETs não têm dado (loading) OU se algum falha, NÃO
 * renderiza — a Home fica intacta e nunca aparece um checklist errado/pela metade.
 *
 * Sinais (reuso, zero backend novo): useConexao (já em voo pela StatusHero) +
 * useServicos + useHorarios. Persona é OMITIDA (backend não expõe prompt_custom no
 * front — ver flag em lib/guia-ativacao): entra sozinha quando o campo existir.
 */
import {
  IconCheck,
  IconChevronRight,
  IconClock,
  IconScissors,
  IconSparkle,
  IconWhatsapp,
} from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { cn } from '@/lib/cn';
import {
  GUIA_HEADER,
  GUIA_PASSOS_COPY,
  type GuiaPassoKey,
  computeGuiaAtivacao,
  deriveConectado,
  temHorarioConfigurado,
} from '@/lib/guia-ativacao';
import { useConexao, useHorarios, useServicos } from '@/lib/queries';
import Link from 'next/link';

function PassoIcon({ passoKey }: { passoKey: GuiaPassoKey }) {
  switch (passoKey) {
    case 'conectar':
      return <IconWhatsapp size={18} />;
    case 'persona':
      return <IconSparkle size={18} />;
    case 'servicos':
      return <IconScissors size={18} />;
    case 'horarios':
      return <IconClock size={18} />;
  }
}

/** Uma linha do checklist: link pra tela certa; feito = calmo + check, pendente = destaque. */
function PassoRow({ passoKey, done }: { passoKey: GuiaPassoKey; done: boolean }) {
  const copy = GUIA_PASSOS_COPY[passoKey];
  return (
    <Link
      href={copy.href}
      aria-label={done ? `${copy.titulo} — feito, revisar` : `${copy.titulo} — ${copy.cta}`}
      className={cn(
        'group flex items-center gap-3 rounded-card-sm border p-3 outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        done
          ? 'border-line bg-surface/60 hover:bg-surface-hover'
          : 'border-line-strong bg-surface hover:bg-surface-hover active:scale-[0.99]',
      )}
    >
      {/* Disco de status: feito = check verde; pendente = ícone do passo em roxo. */}
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-full',
          done ? 'bg-ok-soft text-ok' : 'bg-brand-soft text-brand',
        )}
        aria-hidden
      >
        {done ? <IconCheck size={18} /> : <PassoIcon passoKey={passoKey} />}
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block font-display text-[14px] font-semibold',
            done ? 'text-ink-soft' : 'text-ink',
          )}
        >
          {copy.titulo}
        </span>
        <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-faint">
          {done ? 'Feito' : copy.descricao}
        </span>
      </span>

      {/* Afordância à direita: pendente = CTA + chevron; feito = só o chevron calmo. */}
      <span className="flex shrink-0 items-center gap-1.5">
        {!done && (
          <span className="hidden font-display text-[12.5px] font-semibold text-brand sm:inline">
            {copy.cta}
          </span>
        )}
        <span
          className={cn('transition-colors', done ? 'text-ink-faint' : 'text-brand')}
          aria-hidden
        >
          <IconChevronRight size={16} />
        </span>
      </span>
    </Link>
  );
}

export function GuiaAtivacao() {
  const { slot } = useTenant();
  const conexao = useConexao(slot);
  const servicos = useServicos(slot);
  const horarios = useHorarios(slot);

  // Fail-closed: só decide com os 3 sinais em mãos. Loading/erro => nada (byte-idêntico).
  if (!conexao.data || !servicos.data || !horarios.data) return null;

  const estado = computeGuiaAtivacao({
    conectado: deriveConectado(conexao.data.ever_connected, conexao.data.connected),
    temServicos: servicos.data.length > 0,
    horariosConfigurados: temHorarioConfigurado(horarios.data),
    // personaCustom: NÃO derivável no front hoje (ver lib/guia-ativacao) -> passo omitido.
  });

  // Regra dura: tudo pronto => a seção some (quem já configurou não vê nada novo).
  if (estado.completo) return null;

  const pct = Math.round((estado.feitos / estado.total) * 100);

  return (
    <section
      aria-labelledby="guia-ativacao-title"
      className="stagger stagger-2 mb-[18px] rounded-card border border-line-strong bg-surface p-[18px] shadow-card"
    >
      <div className="mb-3.5">
        <div className="mb-2 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-brand">
          <IconSparkle size={14} />
          {GUIA_HEADER.kicker}
        </div>
        <h2 id="guia-ativacao-title" className="font-display text-[17px] font-semibold text-ink">
          {GUIA_HEADER.titulo}
        </h2>
        <p className="mt-1 text-[13px] leading-snug text-ink-soft">{GUIA_HEADER.subtitulo}</p>

        {/* Progresso: o texto já anuncia "X de N pronto" pro leitor de tela; a barra
            é decorativa (aria-hidden). width dinâmico = único CSS inline permitido. */}
        <div className="mt-3.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[12.5px] font-semibold text-ink-soft">
              {GUIA_HEADER.progressoLabel(estado.feitos, estado.total)}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-pill bg-line" aria-hidden>
            <div
              className="h-full rounded-pill bg-brand transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      <ul className="flex flex-col gap-2">
        {estado.passos.map((p) => (
          <li key={p.key}>
            <PassoRow passoKey={p.key} done={p.done} />
          </li>
        ))}
      </ul>
    </section>
  );
}
