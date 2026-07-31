'use client';

import { IconInfo, IconPlus, IconTrash } from '@/components/icons';
/**
 * Seção "Perguntas frequentes" (FAQ personalizado, SCRUM-65) dentro de "Meu negócio".
 *
 * O dono cadastra ATÉ 10 pares pergunta/resposta com as respostas "oficiais" do negócio
 * (ex.: "Vocês têm estacionamento?" / "Sim, próprio e gratuito na lateral"). Cada par cai
 * no contexto do bot pela personalização — a assistente passa a responder aquele assunto
 * usando o texto do dono, expandindo a base de conhecimento com o que não está mapeado.
 *
 * Gating (byte-idêntico pros demais clientes): só aparece com
 * `features.faq_personalizado === true` (por-clone via FAQ_PERSONALIZADO_SLOTS — NÃO flag
 * global), lido via useFaqConfig (deriva do /portal/perfil). Durante o load renderiza null
 * (sem flash pra quem não tem a feature). O próprio <section> carrega seu divisor/espaçamento
 * (mt-8/border-t) — nunca num wrapper de página (lição #415: null não deixa spacer órfão).
 *
 * Edição em RASCUNHO + Salvar explícito (replace-set, PUT da lista completa — padrão das
 * frases de comando). NÃO é otimista: validação client-side espelha o backend (máx 10,
 * pergunta 1..120, resposta 1..300; par vazio é descartado, não trava o save dos demais); o
 * 400 é rede de proteção. Sucesso -> toast + fixa a resposta; falha -> toast, mantém o
 * rascunho pro dono corrigir.
 */
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  FAQ_ERROR_MSG,
  FAQ_MAX,
  type FaqDraft,
  type FaqError,
  PERGUNTA_MAX,
  RESPOSTA_MAX,
  addFaq,
  atMaxFaq,
  faqCompletos,
  isFaqDirty,
  isFaqRejeitada,
  isFaqValido,
  removeFaq,
  setFaqPergunta,
  setFaqResposta,
  toFaqDraft,
  toFaqPayload,
  validateFaq,
} from '@/lib/faq';
import { qk, useFaqConfig, useSaveFaq } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export function FaqSection() {
  const { slot } = useTenant();
  const toast = useToast();
  const client = useQueryClient();
  const cfgQ = useFaqConfig(slot);
  const save = useSaveFaq(slot);

  // `saved` = última versão confirmada; `draft` = edição em andamento. `touched` evita
  // estourar o rascunho num refetch em background (mesmo padrão de perfil/planos/frases).
  const [draft, setDraft] = useState<FaqDraft[]>(() => toFaqDraft(cfgQ.data?.faq));
  const [saved, setSaved] = useState<FaqDraft[]>(() => toFaqDraft(cfgQ.data?.faq));
  const touched = useRef(false);

  useEffect(() => {
    if (!cfgQ.data) return;
    const next = toFaqDraft(cfgQ.data.faq);
    setSaved(next);
    if (!touched.current) setDraft(next);
  }, [cfgQ.data]);

  const errors = validateFaq(draft);
  const dirty = isFaqDirty(draft, saved);
  const valido = isFaqValido(draft);
  const noLimite = atMaxFaq(draft);
  const usados = faqCompletos(draft).length;

  function onAdd() {
    touched.current = true;
    setDraft((d) => addFaq(d));
  }
  function onRemove(id: number) {
    touched.current = true;
    setDraft((d) => removeFaq(d, id));
  }
  function onPergunta(id: number, v: string) {
    touched.current = true;
    setDraft((d) => setFaqPergunta(d, id, v));
  }
  function onResposta(id: number, v: string) {
    touched.current = true;
    setDraft((d) => setFaqResposta(d, id, v));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || !valido || save.isPending) return;

    const payload = toFaqPayload(draft);
    save.mutate(
      { faq_personalizado: payload },
      {
        onSuccess: (perfil) => {
          const next = toFaqDraft(
            Array.isArray(perfil.faq_personalizado) ? perfil.faq_personalizado : payload,
          );
          setSaved(next);
          setDraft(next);
          touched.current = false;
          toast.success('Perguntas salvas');
          // Mantém a leitura do formulário principal do perfil coerente com o novo FAQ.
          client.invalidateQueries({ queryKey: qk.perfil(slot) });
        },
        onError: (err) => {
          // O rascunho FICA na tela pro dono corrigir (não reverte). 400 = backend recusou.
          if (isFaqRejeitada(err)) {
            toast.error('Não foi possível salvar. Confira os campos destacados e tente de novo.');
          } else {
            toast.error('Não foi possível salvar. Tente de novo.');
          }
        },
      },
    );
  }

  // Load: nada renderiza (sem flash pra quem não tem a feature).
  if (cfgQ.isPending) {
    return null;
  }
  if (cfgQ.isError) {
    return (
      <SectionShell>
        <ErrorState onRetry={() => cfgQ.refetch()} />
      </SectionShell>
    );
  }
  // Feature OFF pro clone -> some (byte-idêntico pros clientes atuais).
  if (!cfgQ.data?.faq_personalizado) return null;

  return (
    <SectionShell>
      <p className="text-[13px] leading-normal text-ink-soft">
        Cadastre respostas prontas pras dúvidas mais comuns do seu negócio. Quando um cliente
        perguntar sobre um desses assuntos no WhatsApp, o assistente responde com o que você
        escreveu aqui — do seu jeito, sem inventar.
      </p>

      {/* Dica (não é alerta): reforça que o texto é USADO pela assistente. */}
      <div className="mt-3 flex items-start gap-2.5 rounded-[12px] border border-line bg-surface-sunken px-3.5 py-3 text-ink-soft">
        <span className="mt-0.5 shrink-0 text-brand" aria-hidden="true">
          <IconInfo size={17} />
        </span>
        <div className="flex flex-col gap-1.5">
          <p className="text-[12.5px] leading-normal">
            Escreva como se estivesse respondendo o cliente. Ex.:{' '}
            <span className="font-semibold text-ink">Vocês atendem sem agendamento?</span> →{' '}
            <span className="font-semibold text-ink">
              Atendo por ordem de chegada de terça a sábado, das 9h às 18h.
            </span>
          </p>
          <p className="text-[12px] leading-normal text-ink-faint">
            Use aqui só informações do seu negócio (horários, serviços, formas de pagamento). Não
            coloque dados de clientes, como nome, telefone ou CPF.
          </p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3" noValidate>
        {draft.length === 0 ? (
          <p className="rounded-[12px] border border-dashed border-line-strong bg-surface-sunken px-4 py-6 text-center text-[13px] leading-normal text-ink-soft">
            Nenhuma pergunta cadastrada ainda. Adicione a primeira e o assistente já passa a usá-la
            quando o cliente perguntar.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {draft.map((f, i) => (
              <FaqCard
                key={f.id}
                index={i + 1}
                faq={f}
                error={errors.get(f.id)}
                onPergunta={(v) => onPergunta(f.id, v)}
                onResposta={(v) => onResposta(f.id, v)}
                onRemove={() => onRemove(f.id)}
              />
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={onAdd}
          disabled={noLimite}
          className="flex h-11 items-center justify-center gap-2 rounded-field border-[1.5px] border-dashed border-line-strong bg-surface-sunken font-display text-[13.5px] font-semibold text-ink-soft outline-none transition-colors hover:border-brand/50 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50"
        >
          <IconPlus size={17} />
          Adicionar pergunta
        </button>
        <p className="text-[12px] leading-normal text-ink-soft">
          {noLimite
            ? `Você chegou ao limite de ${FAQ_MAX} perguntas.`
            : `${usados} de ${FAQ_MAX} cadastradas.`}
        </p>

        <div className="mt-1 flex items-center gap-3">
          <Button
            type="submit"
            size="inline"
            className="flex-1"
            loading={save.isPending}
            disabled={!dirty || !valido}
          >
            Salvar perguntas
          </Button>
        </div>

        <p aria-live="polite" className="px-0.5 text-[12.5px] leading-normal text-ink-soft">
          {save.isPending
            ? 'Salvando…'
            : dirty
              ? !valido
                ? 'Revise os itens destacados pra poder salvar.'
                : 'Você tem alterações não salvas.'
              : usados === 0
                ? 'Nenhuma pergunta cadastrada — o assistente segue respondendo pelo restante do seu perfil.'
                : 'Tudo salvo. O assistente já responde essas perguntas.'}
        </p>
      </form>
    </SectionShell>
  );
}

/** Cabeçalho + card da seção (reutilizado por todos os estados). */
function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="faq-title" className="flex flex-col gap-3">
      <div>
        <h2 id="faq-title" className="font-display text-[17px] font-semibold text-ink">
          Perguntas frequentes
        </h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
          Respostas prontas que o assistente usa quando o cliente pergunta.
        </p>
      </div>
      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        {children}
      </div>
    </section>
  );
}

/** Um par pergunta/resposta editável: pergunta (linha) + resposta (2-3 frases) + remover. */
function FaqCard({
  index,
  faq,
  error,
  onPergunta,
  onResposta,
  onRemove,
}: {
  index: number;
  faq: FaqDraft;
  error: FaqError | undefined;
  onPergunta: (v: string) => void;
  onResposta: (v: string) => void;
  onRemove: () => void;
}) {
  const respId = `faq-resp-${faq.id}`;
  const respErrId = `${respId}-err`;
  const respCountId = `${respId}-count`;
  const perguntaOver = faq.pergunta.length > PERGUNTA_MAX;
  const respostaOver = faq.resposta.length > RESPOSTA_MAX;

  // "incompleto" = só um dos dois preenchido: aponta o erro no campo QUE FALTA.
  const faltaPergunta = error === 'incompleto' && faq.pergunta.trim() === '';
  const faltaResposta = error === 'incompleto' && faq.resposta.trim() === '';
  const perguntaErro = faltaPergunta
    ? FAQ_ERROR_MSG.incompleto
    : error === 'pergunta_longa'
      ? FAQ_ERROR_MSG.pergunta_longa
      : undefined;
  const respostaErro = faltaResposta
    ? FAQ_ERROR_MSG.incompleto
    : error === 'resposta_longa'
      ? FAQ_ERROR_MSG.resposta_longa
      : undefined;

  return (
    <li className="flex flex-col gap-2.5 rounded-[12px] border border-line bg-surface-sunken p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-display text-[12.5px] font-semibold text-ink-soft">
          Pergunta {index}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remover pergunta ${index}`}
          className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:border-danger/40 hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <IconTrash size={16} />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <Input
          label={`Pergunta ${index}`}
          hideLabel
          value={faq.pergunta}
          onChange={(e) => onPergunta(e.target.value)}
          placeholder="Ex.: Vocês têm estacionamento?"
          error={perguntaErro}
          autoComplete="off"
        />
        <div className="flex justify-end px-0.5">
          <span
            aria-live="polite"
            className={cn(
              'tabular-nums text-[11.5px]',
              perguntaOver ? 'text-danger' : 'text-ink-faint',
            )}
          >
            {faq.pergunta.length}/{PERGUNTA_MAX}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={respId} className="sr-only">
          Resposta {index}
        </label>
        <textarea
          id={respId}
          rows={2}
          value={faq.resposta}
          placeholder="Ex.: Sim, estacionamento próprio e gratuito na lateral do prédio."
          onChange={(e) => onResposta(e.target.value)}
          aria-invalid={respostaErro ? true : undefined}
          aria-describedby={cn(respCountId, respostaErro && respErrId) || undefined}
          className={cn(
            'w-full resize-y rounded-field border-[1.5px] border-line-strong bg-surface px-3.5 py-3 text-[15px] leading-snug text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint',
            'hover:border-[var(--c-input-hover-border)]',
            'focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus',
            respostaErro && 'border-danger',
          )}
        />
        <div className="flex items-start justify-between gap-3 px-0.5">
          {respostaErro ? (
            <p id={respErrId} className="text-[13px] text-danger">
              {respostaErro}
            </p>
          ) : (
            <span />
          )}
          <span
            id={respCountId}
            aria-live="polite"
            className={cn(
              'shrink-0 tabular-nums text-[11.5px]',
              respostaOver ? 'text-danger' : 'text-ink-faint',
            )}
          >
            {faq.resposta.length}/{RESPOSTA_MAX}
          </span>
        </div>
      </div>
    </li>
  );
}
