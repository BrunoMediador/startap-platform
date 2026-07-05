'use client';

import { FrasesPausaSection } from '@/components/frases-pausa/frases-pausa-section';
import {
  IconChevronLeft,
  IconChevronRight,
  IconPause,
  IconPlay,
  IconSearch,
} from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import type { PausaRow, RecentContact } from '@/lib/api-types';
import { formatPausadoHa, formatPhoneDisplay, initials, normalizePhone } from '@/lib/format';
import { useAddPausa, useContatos, usePausas, useRemovePausa } from '@/lib/queries';
/**
 * Pausas (spec 6.9/6.10 + 3.5). Lista de pausados + "Pausar um número" (abre
 * sheet de contatos recentes, SEM digitacao livre). Pausar E despausar SEMPRE com
 * CONFIRMACAO explicita (D5 — efeito real no atendimento). Nao otimista: chama,
 * confirma com toast, a lista revalida via invalidateQueries.
 *
 * Feedback de uso real (Bruno): o dono precisa RECONHECER quem esta pausado, entao:
 *  - mostra NOME + numero COMPLETO formatado (sem mascara — o dono ve os proprios
 *    clientes; mascarar e regra de LOG no backend, nao de tela);
 *  - junta /portal/pausas (so telefone) com /portal/contatos (telefone + nome) por
 *    telefone normalizado pra exibir o nome tambem nos pausados;
 *  - o sheet de contatos esconde quem ja esta pausado.
 *
 * Leva 2 (item 4): a lista ficava longa. Busca por numero (normalizado, ignora
 * mascara/espacos) e por nome (se houver) + paginacao client-side de 10 em 10
 * (anterior/proxima + "X–Y de N"). Busca reseta pra pagina 1.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BotSuspeitosSection } from './bot-suspeitos-section';
import { ContactSheet } from './contact-sheet';

const PAGE_SIZE = 10;

/** Nome amigavel de um contato/pausa, com fallback. */
function displayName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'Contato';
}

export default function PausasPage() {
  const { slot } = useTenant();
  const toast = useToast();
  const pausasQ = usePausas(slot);
  // Contatos sempre habilitado nesta tela: precisamos do mapa telefone->nome
  // pra exibir o nome nos pausados (join client-side) e pra abrir o sheet.
  const contatosQ = useContatos(slot, true);
  const addPausa = useAddPausa(slot);
  const removePausa = useRemovePausa(slot);

  const [sheetOpen, setSheetOpen] = useState(false);
  // confirmacao de PAUSAR um contato escolhido no sheet
  const [pausando, setPausando] = useState<RecentContact | null>(null);
  // confirmacao de DESPAUSAR uma linha existente
  const [despausando, setDespausando] = useState<PausaRow | null>(null);
  // busca + paginacao (item 4)
  const [busca, setBusca] = useState('');
  const [page, setPage] = useState(1);

  const pausas = pausasQ.data?.pausas ?? [];
  const contatos = useMemo(() => contatosQ.data?.contacts ?? [], [contatosQ.data]);

  // Mapa telefone-normalizado -> nome do contato (join pra nomear os pausados).
  const nomePorTelefone = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contatos) {
      const key = normalizePhone(c.phone);
      const nome = c.name?.trim();
      if (key && nome) map.set(key, nome);
    }
    return map;
  }, [contatos]);

  // Conjunto de telefones ja pausados (normalizados) — filtra o sheet (item 4 da leva 1).
  const pausadosSet = useMemo(
    () => new Set(pausas.map((p) => normalizePhone(p.telefone))),
    [pausas],
  );

  /** Nome a exibir pra um pausado: do join (se houver) ou null (mostra so o numero). */
  function nomePausado(p: PausaRow): string | null {
    return nomePorTelefone.get(normalizePhone(p.telefone)) ?? null;
  }

  // Resolve nome por telefone — reusado pela seção de suspeita de bot (SCRUM-4 PR-E).
  const resolveName = useCallback(
    (telefone: string): string | null => nomePorTelefone.get(normalizePhone(telefone)) ?? null,
    [nomePorTelefone],
  );

  // Filtro por numero (normalizado) e por nome. Busca vazia = lista inteira.
  const buscaDigitos = busca.replace(/\D/g, '');
  const buscaTexto = busca.trim().toLowerCase();
  const filtradas = useMemo(() => {
    if (busca.trim() === '') return pausas;
    return pausas.filter((p) => {
      const tel = normalizePhone(p.telefone);
      const porNumero = buscaDigitos.length > 0 && tel.includes(buscaDigitos);
      const nome = nomePorTelefone.get(normalizePhone(p.telefone))?.toLowerCase();
      const porNome = nome ? nome.includes(buscaTexto) : false;
      return porNumero || porNome;
    });
    // nomePorTelefone entra na dep pra refiltrar quando os contatos chegam.
  }, [pausas, busca, buscaDigitos, buscaTexto, nomePorTelefone]);

  // Paginacao client-side de 10/10 (item 4).
  const totalPages = Math.max(1, Math.ceil(filtradas.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const inicio = (pageSafe - 1) * PAGE_SIZE;
  const visiveis = filtradas.slice(inicio, inicio + PAGE_SIZE);
  const de = filtradas.length === 0 ? 0 : inicio + 1;
  const ate = inicio + visiveis.length;

  // Busca reseta pra pagina 1 (item 4). Tambem volta se a lista encolher.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset de pagina ao mudar a busca e intencional
  useEffect(() => {
    setPage(1);
  }, [busca]);

  function onSelectContato(c: RecentContact) {
    setSheetOpen(false);
    setPausando(c);
  }

  function confirmPausar() {
    const c = pausando;
    if (!c) return;
    addPausa.mutate(c.phone, {
      onSuccess: () => {
        setPausando(null);
        toast.success(`${displayName(c.name)} pausado`);
      },
      onError: () => {
        setPausando(null);
        toast.error('Não foi possível pausar. Tente de novo.');
      },
    });
  }

  function confirmDespausar() {
    const p = despausando;
    if (!p) return;
    const rotulo = nomePausado(p) ?? formatPhoneDisplay(p.telefone);
    removePausa.mutate(p.telefone, {
      onSuccess: () => {
        setDespausando(null);
        toast.success(`${rotulo} despausado`);
      },
      onError: () => {
        setDespausando(null);
        toast.error('Não foi possível despausar. Tente de novo.');
      },
    });
  }

  const despausandoNome = despausando ? nomePausado(despausando) : null;

  return (
    <>
      <PageHead
        title="Pausas"
        subtitle="Números que o robô não vai responder. Útil pra atender alguém na mão."
      />

      {/* Suspeita de bot (SCRUM-4 PR-E): some sozinha enquanto a auto-pausa estiver OFF. */}
      <BotSuspeitosSection slot={slot} resolveName={resolveName} />

      {pausasQ.isPending ? (
        <>
          <span className="sr-only">Carregando números pausados…</span>
          <SkeletonList rows={3} />
        </>
      ) : pausasQ.isError ? (
        <ErrorState onRetry={() => pausasQ.refetch()} />
      ) : pausas.length === 0 ? (
        <EmptyState
          icon={<IconPause size={26} />}
          title="Nenhum número pausado"
          description="Quando precisar atender alguém manualmente, pause o robô para esse contato aqui."
          action={{ label: 'Pausar um número', onClick: () => setSheetOpen(true) }}
        />
      ) : (
        <>
          {/* Busca por nome ou numero (item 4). So aparece quando vale a pena. */}
          {pausas.length > PAGE_SIZE && (
            <div className="relative mb-3">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint">
                <IconSearch size={18} />
              </span>
              <input
                type="search"
                inputMode="search"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                aria-label="Buscar pausados por nome ou número"
                placeholder="Buscar por nome ou número"
                className="h-[46px] w-full rounded-field border-[1.5px] border-line-strong bg-surface-sunken pl-[42px] pr-3.5 text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint hover:border-[var(--c-input-hover-border)] focus:border-brand focus:shadow-focus focus:ring-[3px] focus:ring-brand/35"
              />
            </div>
          )}

          {filtradas.length === 0 ? (
            <div className="rounded-card border border-line bg-surface px-6 py-10 text-center shadow-card">
              <h3 className="font-display text-[15px] font-semibold text-ink">
                Nenhum resultado para "{busca.trim()}"
              </h3>
              <p className="mt-1 text-[13px] text-ink-soft">
                Tente outro nome ou número, ou limpe a busca.
              </p>
            </div>
          ) : (
            <div className="stagger stagger-2 mb-3.5 overflow-hidden rounded-card border border-line bg-surface shadow-card">
              {visiveis.map((p) => {
                const nome = nomePausado(p);
                const numero = formatPhoneDisplay(p.telefone);
                return (
                  <div
                    key={p.telefone}
                    className="group flex min-h-16 items-center gap-3.5 border-b border-line-soft px-[15px] py-3.5 transition-colors last:border-b-0 hover:bg-surface-hover"
                  >
                    <span className="flex size-[42px] shrink-0 items-center justify-center rounded-[12px] bg-warn-soft font-display text-[14px] font-bold text-warn">
                      {nome ? initials(nome) : <IconPause size={20} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      {nome ? (
                        <>
                          <div className="truncate font-display text-[15px] font-semibold text-ink">
                            {nome}
                          </div>
                          <div className="mt-0.5 text-[12.5px] tabular-nums text-ink-soft">
                            {numero} · {formatPausadoHa(p.updated_at)}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="truncate font-display text-[15px] font-semibold tabular-nums text-ink">
                            {numero}
                          </div>
                          <div className="mt-0.5 text-[12.5px] text-ink-soft">
                            {formatPausadoHa(p.updated_at)}
                          </div>
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setDespausando(p)}
                      className="h-10 shrink-0 rounded-[11px] border border-line-strong bg-surface px-4 font-display text-[13.5px] font-semibold text-brand outline-none transition-colors hover:border-line-strong hover:bg-surface-elev-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                    >
                      Despausar
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Controles de paginacao (item 4) — so se houver mais de 1 pagina. */}
          {filtradas.length > 0 && totalPages > 1 && (
            <div className="mb-3.5 flex items-center justify-between gap-3">
              <span className="text-[12.5px] tabular-nums text-ink-soft">
                {de}–{ate} de {filtradas.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Página anterior"
                  disabled={pageSafe <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="flex size-10 items-center justify-center rounded-[11px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <IconChevronLeft size={18} />
                </button>
                <span className="min-w-[64px] text-center text-[12.5px] tabular-nums text-ink-soft">
                  {pageSafe} / {totalPages}
                </span>
                <button
                  type="button"
                  aria-label="Próxima página"
                  disabled={pageSafe >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="flex size-10 items-center justify-center rounded-[11px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <IconChevronRight size={18} />
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex h-[52px] w-full items-center justify-center gap-2.5 rounded-card bg-brand font-display text-[15px] font-semibold text-bg outline-none transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-[0.98] active:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <IconPause size={20} />
            Pausar um número
          </button>
        </>
      )}

      {/* Frases de comando (modo atendente, SCRUM-59): auto-gated — some byte-idêntico
          pros clientes sem a feature. Carrega o próprio divisor (mt-8/border-t). */}
      <FrasesPausaSection slot={slot} />

      <ContactSheet
        open={sheetOpen}
        slot={slot}
        pausadosSet={pausadosSet}
        onClose={() => setSheetOpen(false)}
        onSelect={onSelectContato}
      />

      <ConfirmDialog
        open={pausando !== null}
        icon={<IconPause size={24} />}
        title={`Pausar atendimento de ${pausando ? displayName(pausando.name) : 'esse contato'}?`}
        description="O robô vai parar de responder esse contato até você despausar."
        confirmLabel="Pausar"
        loading={addPausa.isPending}
        onConfirm={confirmPausar}
        onCancel={() => setPausando(null)}
      />

      <ConfirmDialog
        open={despausando !== null}
        icon={<IconPlay size={24} />}
        title={`Voltar a atender ${
          despausandoNome ??
          (despausando ? formatPhoneDisplay(despausando.telefone) : 'esse contato')
        }?`}
        description="O robô vai responder esse contato normalmente de novo."
        confirmLabel="Despausar"
        loading={removePausa.isPending}
        onConfirm={confirmDespausar}
        onCancel={() => setDespausando(null)}
      />
    </>
  );
}
