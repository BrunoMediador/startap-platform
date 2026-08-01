'use client';

/**
 * Seção "Tom da conversa do assistente" (SCRUM-92) dentro de "Meu negócio", irmã de
 * "Monte seu atendente" e "Cartão de confirmação".
 *
 * O dono arrasta um SLIDER de 4 paradas (do mais direto ao mais caloroso). Cada parada
 * mapeia um NÍVEL do catálogo (direto / equilibrado / caloroso / bem_descontraido); o
 * backend traduz o nível pra temperatura do modelo — o dono NUNCA vê número.
 *
 * ── Degradação graciosa ─────────────────────────────────────────────────────────────
 *   - GET 404 (feature off / sem config) -> a seção SOME inteira (byte-idêntico pros
 *     clientes atuais, mesmo critério do prompt-builder/cartão).
 *   - Erro REAL (rede/500) -> ErrorState com retry (não some silenciosamente).
 *   - isPending -> nada renderiza (sem flash pra quem não tem a feature).
 *
 * A11y: o controle é um <input type="range"> nativo (role=slider de graça, teclado + toque),
 * com aria-valuetext = rótulo do tom (o leitor de tela anuncia "Equilibrado", não "1"). O
 * range fica transparente por cima de um trilho desenhado (fill + paradas) pra visual
 * consistente cross-browser.
 *
 * Copy: TODA string que o cliente vê vem de TOM_COPY (lib/tom-assistente) — DRAFT, o PM
 * confirma com o Bruno antes do ar. Nunca envia slot (o cookie viaja sozinho no apiFetch).
 */
import { IconSparkle } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { useRegistrarNaoSalvo } from '@/components/shell/unsaved-changes-context';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { useSaveTomAssistente, useTomAssistente } from '@/lib/queries';
import {
  TOM_COPY,
  type TomNivel,
  type TomNivelOpcao,
  indexToNivel,
  isTomInvalido,
  labelDoNivel,
  nivelToIndex,
  ordenarNiveis,
} from '@/lib/tom-assistente';
import { useEffect, useRef, useState } from 'react';

export function TomAssistenteSection() {
  const { slot } = useTenant();
  const q = useTomAssistente(slot);

  // Sem flash pra quem não tem a feature; erro real vira ErrorState; 404 -> some.
  if (q.isPending) return null;
  if (q.isError) {
    return (
      <SectionShell>
        <ErrorState onRetry={() => q.refetch()} />
      </SectionShell>
    );
  }
  if (!q.data || q.data.status === 'indisponivel') return null;

  return <TomForm slot={slot} nivelInicial={q.data.nivel} niveis={q.data.niveis} />;
}

// ── Formulário (estado OK) ───────────────────────────────────────────────────────

function TomForm({
  slot,
  nivelInicial,
  niveis,
}: {
  slot: string;
  nivelInicial: TomNivel;
  niveis: TomNivelOpcao[];
}) {
  const toast = useToast();
  const save = useSaveTomAssistente(slot);

  // Paradas ordenadas (esquerda->direita = ordem asc) = fonte da posição do slider.
  const paradas = ordenarNiveis(niveis);

  const [saved, setSaved] = useState<TomNivel>(nivelInicial);
  const [draft, setDraft] = useState<TomNivel>(nivelInicial);
  const touched = useRef(false);

  // Re-hidrata do servidor só enquanto o dono não tocou (não estoura edição em refetch).
  useEffect(() => {
    if (touched.current) return;
    setSaved(nivelInicial);
    setDraft(nivelInicial);
  }, [nivelInicial]);

  const dirty = draft !== saved;
  const index = nivelToIndex(draft, paradas);
  const labelAtual = labelDoNivel(draft, paradas);

  function onSlide(idx: number) {
    touched.current = true;
    setDraft(indexToNivel(idx, paradas));
  }

  /**
   * Núcleo do submit (save otimista). Extraído de `onSubmit` pra também
   * poder ser chamado pelo guard global de "alterações não salvas"
   * (SCRUM-158). Sem validação client-side aqui (slider fechado, sempre
   * válido) — resolve assim que o cache aplica o otimista, o `mutate`
   * segue em background com revert no erro.
   */
  function submitTom(): Promise<void> {
    return new Promise((resolve) => {
      if (!dirty || save.isPending) {
        resolve();
        return;
      }

      const prev = saved;
      setSaved(draft); // otimista
      touched.current = false;

      save.mutate(draft, {
        onSuccess: () => {
          toast.success(TOM_COPY.sucesso);
        },
        onError: (err) => {
          setSaved(prev);
          toast.error(isTomInvalido(err) ? TOM_COPY.erroInvalido : TOM_COPY.erroGenerico);
        },
      });
      resolve();
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitTom().catch(() => {
      // erro já tratado (toast) dentro de submitTom.
    });
  }

  // Guarda de navegação GLOBAL (SCRUM-158): registra esta seção no registry
  // central. Este componente (`TomForm`) só monta quando o estado é OK (o
  // pai `TomAssistenteSection` já filtrou loading/erro/indisponível antes).
  useRegistrarNaoSalvo('Tom do assistente', dirty, submitTom);

  return (
    <SectionShell>
      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <p className="text-[13px] leading-normal text-ink-soft">{TOM_COPY.ajuda}</p>

        <TomSlider
          index={index}
          total={paradas.length}
          labelAtual={labelAtual}
          onChange={onSlide}
        />

        <div className="flex flex-col gap-2">
          <Button
            type="submit"
            className="w-full sm:w-auto"
            loading={save.isPending}
            loadingLabel={TOM_COPY.salvando}
            disabled={!dirty}
          >
            {TOM_COPY.salvar}
          </Button>
          <p aria-live="polite" className="text-[12.5px] leading-normal text-ink-soft">
            {save.isPending ? TOM_COPY.salvando : dirty ? TOM_COPY.naoSalvo : TOM_COPY.salvo}
          </p>
        </div>
      </form>
    </SectionShell>
  );
}

// ── Slider de 4 paradas ──────────────────────────────────────────────────────────

/**
 * Slider acessível: <input type="range"> nativo (transparente, por cima) provê drag +
 * teclado + toque + role=slider; o trilho visual (fill + paradas) é desenhado embaixo. As
 * posições saem de cálculo dinâmico (índice/total) — daí o style inline (permitido só pra
 * cálculo). aria-valuetext anuncia o RÓTULO do tom, não o número.
 */
function TomSlider({
  index,
  total,
  labelAtual,
  onChange,
}: {
  index: number;
  total: number;
  labelAtual: string;
  onChange: (idx: number) => void;
}) {
  const max = Math.max(total - 1, 0);
  const pct = max > 0 ? (index / max) * 100 : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-semibold text-ink">{TOM_COPY.atual}</span>
        <span className="font-display text-[14px] font-semibold text-brand">{labelAtual}</span>
      </div>

      {/* Trilho: range transparente (peer) por cima; visual (fill/paradas/polegar) embaixo. */}
      <div className="relative h-10">
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={index}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={TOM_COPY.ariaSlider}
          aria-valuetext={labelAtual}
          className="peer absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
        />
        {/* Trilho base */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-line-strong"
        />
        {/* Trecho preenchido até a parada atual */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-0 h-1.5 -translate-y-1/2 rounded-full bg-brand"
          style={{ width: `${pct}%` }}
        />
        {/* Paradas (uma por nível) */}
        {Array.from({ length: total }).map((_, i) => {
          const p = max > 0 ? (i / max) * 100 : 0;
          const passed = i <= index;
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: paradas são posicionais e estáveis (índice = a própria posição)
              key={i}
              aria-hidden
              className={cn(
                'pointer-events-none absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2',
                passed ? 'border-brand bg-brand' : 'border-line-strong bg-surface',
              )}
              style={{ left: `${p}%` }}
            />
          );
        })}
        {/* Polegar (segue a parada atual) + anel de foco herdado do range (peer) */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand bg-surface shadow-card ring-offset-2 ring-offset-bg transition-[left] peer-focus-visible:ring-2 peer-focus-visible:ring-brand"
          style={{ left: `${pct}%` }}
        />
      </div>

      {/* Rótulos das pontas */}
      <div className="flex items-start justify-between gap-3">
        <span className="max-w-[45%] text-[12px] leading-tight text-ink-soft">
          {TOM_COPY.pontaEsquerda}
        </span>
        <span className="max-w-[45%] text-right text-[12px] leading-tight text-ink-soft">
          {TOM_COPY.pontaDireita}
        </span>
      </div>
    </div>
  );
}

// ── Chrome compartilhado ─────────────────────────────────────────────────────────

/** Cabeçalho + card da seção (traz o próprio divisor mt-8/border-t). */
function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="tom-assistente-title" className="flex flex-col gap-3">
      <div>
        <h2
          id="tom-assistente-title"
          className="flex items-center gap-2 font-display text-[17px] font-semibold text-ink"
        >
          <span className="text-brand" aria-hidden>
            <IconSparkle size={18} />
          </span>
          {TOM_COPY.titulo}
        </h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">{TOM_COPY.subtitulo}</p>
      </div>
      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        {children}
      </div>
    </section>
  );
}
