'use client';

import { IconPencil, IconRefresh, IconSend, IconSparkle } from '@/components/icons';
/**
 * Seção "Monte seu atendente" (SCRUM-92) dentro de "Meu negócio".
 *
 * O dono conversa com um assistente de configuração (meta-agente no DeepSeek) que faz
 * 4-5 perguntas simples e PROPÕE a personalidade do assistente de WhatsApp dele. Ao aprovar, a
 * persona vira o prompt de produção do clone — a mecânica de agendamento (confirmação) OU o
 * encaminhamento pra humano (modo atendente) é garantido por CÓDIGO no servidor e NUNCA depende
 * do que a IA gerar (o dono só cuida da personalidade/tom/nome/regras). Ver design SCRUM-92.
 *
 * Copy sensível ao MODO do clone: agenda (marca horário -> "confirmação antes de marcar") vs
 * atendente (pré-venda que escala -> "encaminhar pra um atendente humano"). O modo vem do
 * MESMO GET /portal/perfil já lido pela página (features.modo_atendente + perfil.agenda_automatica),
 * via useAgendaConfig — sem fetch novo (React Query dedup com a AgendamentoSection irmã).
 *
 * Gating (byte-idêntico pros demais clientes): a seção PROBA o GET /portal/prompt-builder/
 * draft (useBuilderDraft). 404 (flag PROMPT_BUILDER_ENABLED OFF) -> {status:'indisponivel'}
 * -> renderiza null (some, sem flash). Erro real (rede/500) -> ErrorState com retry. O
 * <section> carrega seu próprio divisor (mt-8/border-t) — null não deixa spacer órfão.
 *
 * A conversa é estado LOCAL efêmero (o back guarda no Redis com TTL); o único artefato
 * durável é o prompt APROVADO. Sem PII logada no client.
 */
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  BUILDER_MAX_INPUT,
  type BuilderMessage,
  type BuilderModo,
  type DiffPart,
  PERSONA_MAX_CHARS,
  appendMessage,
  approveBuilder,
  diffPersona,
  diffToPlainText,
  generateNowContent,
  isPersonaSavable,
  isSendable,
  personaCharsLeft,
  remainingChars,
  resetBuilder,
  resolveDiffBase,
  resolvePersonaAtual,
  sendBuilderMessage,
  startBuilder,
} from '@/lib/prompt-builder';
import { qk, useAgendaConfig, useBuilderDraft } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

/**
 * Copy da garantia da mecânica, condicional ao modo do clone (item 2). No modo atendente o
 * bot NÃO marca horário — ele encaminha pra um humano; falar de "confirmação antes de marcar"
 * confunde o dono. `full` = nota do IntroCard; `nota` = tranquilizador na prévia (no lugar do
 * bloco técnico, item 3); `editor` = nota do editor de persona.
 */
interface GarantiaCopy {
  full: string;
  nota: string;
  editor: string;
}

function garantiaCopy(atendente: boolean): GarantiaCopy {
  if (atendente) {
    return {
      full: 'A parte técnica (encaminhar pra um atendente humano na hora certa) já é garantida automaticamente. Você só cuida da personalidade dele.',
      nota: 'Encaminhar pra um atendente humano quando precisar já é garantido automaticamente pelo sistema — você não precisa escrever isso.',
      editor:
        'Ajuste o texto como preferir. O encaminhamento pra um atendente humano continua garantido automaticamente — não precisa escrevê-lo aqui.',
    };
  }
  return {
    full: 'A parte técnica (a confirmação antes de marcar um horário) já é garantida automaticamente. Você só cuida da personalidade dele.',
    nota: 'A confirmação antes de marcar um horário já é garantida automaticamente pelo sistema — você não precisa escrever isso.',
    editor:
      'Ajuste o texto como preferir. A confirmação antes de marcar um horário continua garantida automaticamente — não precisa escrevê-la aqui.',
  };
}

export function MonteAssistenteSection() {
  const { slot } = useTenant();
  const toast = useToast();
  const client = useQueryClient();
  const draftQ = useBuilderDraft(slot);
  // Modo do clone (item 2): reusa o GET /portal/perfil já lido pela página (dedup por key).
  // Atendente PURO = pré-venda que escala pra humano (modo_atendente ON e agenda automática
  // OFF); se a agenda estiver ligada, o clone marca horário -> copy de agendamento.
  const agendaCfg = useAgendaConfig(slot).data;
  const isAtendente = agendaCfg?.modo_atendente === true && agendaCfg?.agenda_automatica !== true;
  const copy = garantiaCopy(isAtendente);

  const [messages, setMessages] = useState<BuilderMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  // Texto da última mensagem que falhou por erro transitório -> botão "tentar de novo".
  const [erroRetry, setErroRetry] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  // Diálogos SEPARADOS (item 1 e 5): aprovar (substitui a persona de PRODUÇÃO), rejeitar
  // (descarta só a prévia, mantém a entrevista) e recomeçar (apaga a entrevista). Estados
  // independentes — nunca compartilham o do reset.
  const [confirmApprove, setConfirmApprove] = useState<{ persona?: string } | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // Rascunho ficou pronto NESTE turno (antes do refetch do draft confirmar) — snappy.
  const [localDraftReady, setLocalDraftReady] = useState(false);
  // "Rejeitar" (item 5): esconde a prévia localmente pra continuar ajustando no chat, sem
  // apagar a entrevista. Rearmado quando uma prévia NOVA é gerada (enviar/gerar agora).
  const [previewDismissed, setPreviewDismissed] = useState(false);
  // Persona aplicada com sucesso (pós-approve) -> card de confirmação.
  const [aplicada, setAplicada] = useState(false);
  // Caminho "Editar": textarea aberta + texto da persona sendo ajustado pelo dono.
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  // Preview ao vivo (ordem do Bruno 31/07): modo da sessão + rascunho corrente, atualizados
  // a cada turno via /message (não dependem mais de esperar draft_ready pra existir).
  const [modo, setModo] = useState<BuilderModo>('criacao');
  const [personaAoVivo, setPersonaAoVivo] = useState<string | null>(null);
  // persona_base também volta em TODA resposta de /message (confirmado 31/07, já no 1º
  // turno) — captura local evita depender só do staleTime/refetch da query useBuilderDraft.
  const [personaBaseAoVivo, setPersonaBaseAoVivo] = useState<string | null>(null);
  // Alternância "ver com marcações / ver texto limpo" do painel de diff.
  const [verMarcacoes, setVerMarcacoes] = useState(true);

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const draft = draftQ.data;
  const started = messages.length > 0;
  const previewReady = localDraftReady || draft?.status === 'pronto';
  // Prévia REALMENTE renderizável (não só o snappy local): texto final chegou do servidor.
  const previewPronto = draft?.status === 'pronto' && !!draft.previewFinal;
  // Prévia visível: pronta E não descartada pelo dono ("Rejeitar").
  const showPreview = previewReady && !previewDismissed;
  const personaBase =
    personaBaseAoVivo ?? (draft?.status !== 'indisponivel' ? (draft?.personaBase ?? null) : null);
  // Rascunho corrente (proposta em cima da base): prioriza o que chegou NESTE turno
  // (snappy); cai pro do draft do servidor quando ainda não houve turno nesta sessão
  // (retomada com rascunho salvo no Redis).
  const rascunhoAtual =
    personaAoVivo ?? (draft?.status !== 'indisponivel' ? (draft?.personaRascunho ?? null) : null);
  // Texto corrente do painel: o RASCUNHO se já existir; senão, em melhoria, a persona
  // BASE (texto no ar) — o painel mostra "de cara" o texto atual mesmo ANTES do dono
  // trocar 1 mensagem (item 1, ordem do Bruno). Em criação sem rascunho -> null (vazio
  // honesto: ainda não há nada pra mostrar).
  const personaAtual = resolvePersonaAtual(rascunhoAtual, personaBase);
  const diffBase = resolveDiffBase(modo, personaBase);

  // Auto-scroll pro fim quando entra bolha ou aparece/some o "digitando". O painel de
  // prévia é ANCORADO (sticky) — não precisa mais de scrollIntoView pra "trazer pra
  // dentro da viewport" (a prévia já está sempre visível).
  const totalMsgs = messages.length;
  useEffect(() => {
    void totalMsgs;
    void pending;
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [totalMsgs, pending]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Ações ─────────────────────────────────────────────────────────────────
  /** Inicia (ou retoma, idempotente) a entrevista via /start. */
  async function iniciar() {
    if (pending) return;
    setErroRetry(null);
    setAplicada(false);
    setPending(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const out = await startBuilder(ctrl.signal);
    setPending(false);
    if (out.kind === 'ok') {
      // Retomada (item 6): reidrata o histórico completo em vez de reiniciar na 1ª pergunta.
      // Garante que a última pergunta apareça (append só se o backend não a trouxe no fim).
      const hist = out.turns;
      if (hist.length > 0) {
        const last = hist[hist.length - 1];
        const jaTemPergunta = last.role === 'assistant' && last.text === out.pergunta;
        setMessages(
          !jaTemPergunta && out.pergunta ? appendMessage(hist, 'assistant', out.pergunta) : hist,
        );
      } else {
        setMessages([{ id: 1, role: 'assistant', text: out.pergunta }]);
      }
      setLocalDraftReady(out.draftReady);
      setModo(out.modo);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (out.kind === 'unavailable') {
      toast.error('O assistente de configuração está indisponível agora. Tente mais tarde.');
      return;
    }
    toast.error('Não foi possível começar agora. Tente de novo.');
  }

  /**
   * Envia 1 turno. `generateNow` (botão "Gerar agora") pode ser disparado a QUALQUER momento —
   * inclusive sem o dono ter digitado nada: manda um texto curto padrão e o backend FORÇA a
   * geração da persona neste turno. No fluxo normal, exige texto enviável (isSendable).
   */
  async function enviar(texto: string, opts?: { generateNow?: boolean }) {
    const generateNow = opts?.generateNow === true;
    const digitado = texto.trim();
    if (generateNow) {
      if (pending) return; // "Gerar agora" só barra se já há um envio em andamento.
    } else if (!isSendable(texto, pending)) {
      return;
    }
    const conteudo = generateNow ? generateNowContent(texto) : digitado;
    setErroRetry(null);
    setInput('');
    // Bolha do dono só quando ele REALMENTE escreveu algo (evita bolha fantasma do texto padrão).
    if (digitado.length > 0) setMessages((m) => appendMessage(m, 'user', digitado));
    setPending(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const out = await sendBuilderMessage(conteudo, { signal: ctrl.signal, generateNow });
    setPending(false);

    if (out.kind === 'ok') {
      setMessages((m) => appendMessage(m, 'assistant', out.reply));
      // Preview ao vivo (item 1): atualiza a CADA turno que trouxer rascunho/base novos,
      // mesmo antes de draft_ready — o painel ancorado reage em tempo real, sem esperar a
      // IA chamar a tool de propor_prompt. Campo ausente/null (backend antigo) -> sem
      // update, degrada pro comportamento anterior.
      if (out.personaRascunho) setPersonaAoVivo(out.personaRascunho);
      if (out.personaBase) setPersonaBaseAoVivo(out.personaBase);
      if (out.draftReady) {
        setLocalDraftReady(true);
        setPreviewDismissed(false); // prévia NOVA volta a aparecer mesmo após um "Rejeitar"
        // Busca o preview_final (não volta no /message) pro painel de prévia.
        client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      }
      return;
    }
    if (out.kind === 'not_started') {
      toast.error('A conversa expirou. Vamos recomeçar do zero.');
      setMessages([]);
      setLocalDraftReady(false);
      setPersonaAoVivo(null);
      setPersonaBaseAoVivo(null);
      client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      return;
    }
    if (out.kind === 'invalid') {
      setMessages((m) => appendMessage(m, 'assistant', 'Não peguei bem. Pode reescrever?'));
      return;
    }
    if (out.kind === 'unavailable') {
      toast.error('O assistente de configuração está indisponível agora. Tente mais tarde.');
      return;
    }
    // erro transitório -> guarda pra reenviar
    setErroRetry(conteudo);
  }

  /**
   * "Pedir ajuste"/"Continuar a conversa": com o painel sempre visível (item 1), este
   * botão pode ser clicado ANTES de qualquer turno (`!started`) — precisa iniciar a
   * sessão DE VERDADE (`/start`), não simular uma bolha local, senão o 1º envio bate
   * 409 `entrevista_nao_iniciada` (o backend não sabe que essa conversa existe).
   */
  function pedirAjuste() {
    if (!started) {
      void iniciar();
      return;
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  /**
   * Aprova a persona. Sem argumento => aprova o RASCUNHO do servidor (botão "Aprovar e ativar").
   * Com `personaEditada` => aprova o TEXTO editado pelo dono (botão "Salvar e ativar" do editor).
   * Em ambos, o BLOCO_ESTRUTURAL (confirmação/encaminhamento) é colado por código no backend.
   * Chamado sempre DEPOIS do ConfirmDialog (item 1) — a ação escreve na PRODUÇÃO.
   */
  async function aprovar(personaEditada?: string) {
    if (approving) return;
    setApproving(true);
    const out = await approveBuilder(personaEditada);
    setApproving(false);
    if (out.kind === 'ok') {
      toast.success('Pronto! Seu assistente já está com a nova personalidade.');
      setMessages([]);
      setInput('');
      setLocalDraftReady(false);
      setPreviewDismissed(false);
      setEditing(false);
      setEditText('');
      setPersonaAoVivo(null);
      setPersonaBaseAoVivo(null);
      setAplicada(true);
      client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      client.invalidateQueries({ queryKey: qk.perfil(slot) });
      return;
    }
    if (out.kind === 'no_draft') {
      toast.error('O rascunho expirou. Vamos recomeçar.');
      setMessages([]);
      setLocalDraftReady(false);
      setEditing(false);
      client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      return;
    }
    if (out.kind === 'invalid') {
      toast.error(
        editing
          ? 'Esse texto não pôde ser salvo — ficou curto demais ou sem personalidade suficiente. Ajuste e tente de novo.'
          : 'O rascunho ainda está curto. Conte mais uns detalhes no chat e tente de novo.',
      );
      return;
    }
    if (out.kind === 'unavailable') {
      toast.error('Recurso indisponível agora. Tente mais tarde.');
      return;
    }
    toast.error('Não foi possível ativar. Tente de novo.');
  }

  /**
   * "Salvar" sempre disponível (item 3, ordem do Bruno): o dono não precisa saber se já
   * existe rascunho. Com rascunho pronto -> approve normal (abre o ConfirmDialog de
   * sempre). Sem rascunho -> força a geração AGORA (generate_now:true) e, assim que o
   * rascunho voltar, abre o MESMO ConfirmDialog de aprovar — um único gesto do dono.
   */
  async function salvarSempre() {
    if (previewPronto) {
      setConfirmApprove({});
      return;
    }
    if (pending || approving) return;
    setPending(true);
    setErroRetry(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const out = await sendBuilderMessage(generateNowContent(input), {
      signal: ctrl.signal,
      generateNow: true,
    });
    setPending(false);
    setInput('');
    if (out.kind === 'ok') {
      setMessages((m) => appendMessage(m, 'assistant', out.reply));
      if (out.personaRascunho) setPersonaAoVivo(out.personaRascunho);
      if (out.personaBase) setPersonaBaseAoVivo(out.personaBase);
      setPreviewDismissed(false);
      if (out.draftReady) {
        setLocalDraftReady(true);
        client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      }
      // Abre a confirmação de aprovar assim que o rascunho existir — o dono só clicou
      // "Salvar" uma vez, o resto é o backend forçando a geração.
      if (out.draftReady) setConfirmApprove({});
      else toast.error('Ainda não consegui gerar uma personalidade — conte mais um pouco no chat.');
      return;
    }
    if (out.kind === 'not_started') {
      toast.error('A conversa expirou. Vamos recomeçar do zero.');
      setMessages([]);
      setLocalDraftReady(false);
      setPersonaAoVivo(null);
      setPersonaBaseAoVivo(null);
      client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      return;
    }
    if (out.kind === 'unavailable') {
      toast.error('O assistente de configuração está indisponível agora. Tente mais tarde.');
      return;
    }
    toast.error('Não foi possível salvar agora. Tente de novo.');
  }

  /** Abre o editor da persona SEMEADO com o rascunho corrente (persona pura, sem o bloco
   * estrutural). O painel de prévia é sticky/ancorado — não precisa mais rolar até ele. */
  function editar() {
    setEditText(personaAtual ?? '');
    setEditing(true);
    requestAnimationFrame(() => editRef.current?.focus());
  }

  /**
   * Salva o texto editado (= approve com persona_editada). Gate de tamanho no front + confirma
   * antes de escrever na PRODUÇÃO (item 1) — mesmo caminho do "Aprovar e ativar".
   */
  function salvarEdicao() {
    if (!isPersonaSavable(editText)) return;
    setConfirmApprove({ persona: editText });
  }

  function cancelarEdicao() {
    setEditing(false);
    setEditText('');
  }

  /**
   * "Rejeitar" (item 5): descarta SÓ a prévia e leva o dono de volta ao chat pra continuar
   * ajustando. NÃO apaga a entrevista (diferente de "Recomeçar do zero"). Se o chat ainda não
   * estava aberto (carregou com um rascunho pronto), retoma a conversa pra ele poder ajustar.
   */
  function descartarPrevia() {
    setConfirmReject(false);
    setPreviewDismissed(true);
    if (!started) {
      void iniciar();
    } else {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  /** "Recomeçar do zero" (item 5): apaga o estado Redis da entrevista e volta ao início. */
  async function recomecar() {
    setConfirmReset(false);
    await resetBuilder();
    setMessages([]);
    setInput('');
    setErroRetry(null);
    setLocalDraftReady(false);
    setPreviewDismissed(false);
    setAplicada(false);
    setEditing(false);
    setEditText('');
    // Só o RASCUNHO (proposta em cima da base) é apagado — a persona BASE (texto que
    // está no ar hoje) e o `modo` da sessão continuam os mesmos: "recomeçar" reinicia a
    // ENTREVISTA, não o estado real do clone. O próximo `iniciar()` re-sincroniza ambos
    // via /start (o backend decide `modo` pelo estado real, nunca reset local).
    setPersonaAoVivo(null);
    client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void enviar(input);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter envia; Shift+Enter quebra linha (padrão de chat).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void enviar(input);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  // Load inicial: nada renderiza (sem flash pra quem não tem a feature).
  if (draftQ.isPending) return null;
  // Feature OFF (404 -> indisponivel): some (byte-idêntico pros clientes atuais).
  if (draft?.status === 'indisponivel') return null;
  // Erro real (rede/500): a seção existe -> mostra retry (não some silenciosamente).
  if (draftQ.isError || !draft) {
    return (
      <SectionShell>
        <ErrorState onRetry={() => draftQ.refetch()} />
      </SectionShell>
    );
  }

  // Diff a exibir no painel ao vivo: base resolvida (persona_base em melhoria, null em
  // criação) contra o texto corrente (rascunho do turno mais recente).
  const diffParts = personaAtual ? diffPersona(diffBase, personaAtual) : [];

  return (
    <SectionShell>
      {aplicada ? (
        <AplicadaCard onReconfigurar={iniciar} pending={pending} atendente={isAtendente} />
      ) : (
        /*
         * Painel de preview ANCORADO (item 1, ordem do Bruno): visível desde o COMEÇO da
         * sessão — inclusive ANTES do dono clicar "Começar"/"Conversar agora" (em melhoria,
         * mostra de cara a persona_base = texto que está no ar). No mobile fica STICKY logo
         * abaixo da topbar; no desktop vira coluna lateral sticky ao lado do chat/intro. Sem
         * scrollIntoView, sem "role a tela pra baixo" em nenhum estado.
         */
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <div className="order-2 flex flex-col gap-4 lg:order-1">
            {!started && !previewReady && draft.status === 'sem_rascunho' && (
              <RetomarCard
                onContinuar={iniciar}
                onRecomecar={() => setConfirmReset(true)}
                pending={pending}
              />
            )}
            {!started && !previewReady && draft.status !== 'sem_rascunho' && (
              <IntroCard onStart={iniciar} pending={pending} garantia={copy.full} modo={modo} />
            )}
            {started && (
              <ChatView
                messages={messages}
                pending={pending}
                input={input}
                erroRetry={erroRetry}
                logRef={logRef}
                inputRef={inputRef}
                modo={modo}
                onInput={setInput}
                onSubmit={onSubmit}
                onKeyDown={onKeyDown}
                onRetry={() => erroRetry && void enviar(erroRetry)}
                onGerarAgora={() => void enviar(input, { generateNow: true })}
              />
            )}
          </div>

          <div className="sticky top-[calc(var(--topbar-h)+8px)] z-[5] order-1 max-h-[calc(100dvh-var(--topbar-h)-24px)] overflow-y-auto lg:order-2 lg:top-4 lg:max-h-[calc(100dvh-32px)]">
            {editing ? (
              <EditPersonaPanel
                value={editText}
                saving={approving}
                nota={copy.editor}
                textareaRef={editRef}
                onChange={setEditText}
                onSalvar={salvarEdicao}
                onCancelar={cancelarEdicao}
              />
            ) : (
              <PreviewPanel
                modo={modo}
                montando={showPreview && !previewPronto}
                nomeBot={draft.nomeBot}
                resumo={draft.resumo}
                diffParts={diffParts}
                verMarcacoes={verMarcacoes}
                onToggleMarcacoes={() => setVerMarcacoes((v) => !v)}
                nota={copy.nota}
                approving={approving}
                salvando={pending && !previewPronto}
                // Salvar exige a sessão JÁ iniciada no backend (sendBuilderMessage bate 409
                // sem isso) — antes do 1º "Começar"/"Conversar agora" ainda não há o que
                // gerar/aprovar (mostrar a base intocada como "ativação" seria redundante).
                podeSalvar={started || previewPronto}
                onSalvar={() => void salvarSempre()}
                onEditar={editar}
                editavel={previewPronto}
                onRejeitar={previewPronto ? () => setConfirmReject(true) : undefined}
                onRecomecar={() => setConfirmReset(true)}
                onAjustarConversa={pedirAjuste}
              />
            )}
          </div>
        </div>
      )}

      {/* Item 1: confirma antes de ATIVAR (substitui a persona de produção no WhatsApp). */}
      <ConfirmDialog
        open={confirmApprove !== null}
        title="Ativar esta personalidade?"
        description="Isso substitui a personalidade atual do seu assistente e passa a valer no WhatsApp. Deseja ativar?"
        confirmLabel="Ativar"
        cancelLabel="Cancelar"
        loading={approving}
        onConfirm={() => {
          const p = confirmApprove?.persona;
          setConfirmApprove(null);
          void aprovar(p);
        }}
        onCancel={() => setConfirmApprove(null)}
        icon={<IconSparkle size={22} />}
      />

      {/* Item 5: "Rejeitar" = descarta SÓ a prévia (não apaga a entrevista). */}
      <ConfirmDialog
        open={confirmReject}
        title="Descartar esta prévia?"
        description="Você volta pra conversa e pode continuar ajustando. Isto não apaga a sua entrevista nem altera o assistente que já está no ar."
        confirmLabel="Descartar"
        cancelLabel="Voltar"
        onConfirm={descartarPrevia}
        onCancel={() => setConfirmReject(false)}
        icon={<IconRefresh size={22} />}
      />

      {/* Item 5: "Recomeçar do zero" = apaga a entrevista inteira (diálogo distinto). */}
      <ConfirmDialog
        open={confirmReset}
        title="Recomeçar do zero?"
        description="Isto APAGA a conversa e as respostas que você já deu, e o assistente de configuração começa uma entrevista nova. Não altera o assistente que já está no ar."
        confirmLabel="Recomeçar"
        cancelLabel="Voltar"
        confirmVariant="destructive"
        onConfirm={() => void recomecar()}
        onCancel={() => setConfirmReset(false)}
        icon={<IconRefresh size={22} />}
      />
    </SectionShell>
  );
}

/** Cabeçalho + card da seção (reutilizado por todos os estados). */
function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="monte-assistente-title" className="flex flex-col gap-3">
      <div>
        <h2
          id="monte-assistente-title"
          className="flex items-center gap-2 font-display text-[17px] font-semibold text-ink"
        >
          <span className="text-brand" aria-hidden>
            <IconSparkle size={18} />
          </span>
          Monte seu atendente
        </h2>
        {/* "tom" foi tirado daqui de propósito: o "tom da conversa" tem controle
            próprio (o slider abaixo, nesta mesma página). Aqui é a personalidade —
            comportamento e regras — pra não confundir os dois (item-9). */}
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
          Converse com nosso assistente e defina a personalidade do seu assistente — nome,
          comportamento e regras.
        </p>
      </div>
      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        {children}
      </div>
    </section>
  );
}

/**
 * Estado inicial: explica o que é + botão "Começar". Copy honesta por modo (item 5): no
 * modo criação (fluxo validado em prod, NUNCA muda) é entrevista de 4-5 perguntas; no
 * modo melhoria é conversa livre sobre o texto que já está no ar — dizer "perguntas" aqui
 * foi o que confundiu a cliente Ingrid (achou que a IA reescreveria tudo do zero).
 */
function IntroCard({
  onStart,
  pending,
  garantia,
  modo,
}: {
  onStart: () => void;
  pending: boolean;
  garantia: string;
  modo: BuilderModo;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-normal text-ink-soft">
        {modo === 'melhoria'
          ? 'Converse sobre a personalidade que seu assistente já tem hoje: peça pra acrescentar algo, remover algo, ou mudar o que quiser — sem perder o que já está bom. Você acompanha o texto mudando ao vivo, e só ativa quando estiver do seu jeito.'
          : 'Em 4 ou 5 perguntas rápidas, deixamos o seu assistente com a cara do seu negócio: como ele fala, se tem nome, e o que ele nunca deve fazer. Sem termos técnicos — é só conversar.'}
      </p>
      <GarantiaNota texto={garantia} />
      <div>
        <Button size="inline" onClick={onStart} loading={pending} loadingLabel="Abrindo…">
          <IconSparkle size={17} />
          {modo === 'melhoria' ? 'Conversar agora' : 'Começar'}
        </Button>
      </div>
    </div>
  );
}

/** Há uma entrevista em andamento (Redis vivo) mas sem rascunho -> continuar/recomeçar. */
function RetomarCard({
  onContinuar,
  onRecomecar,
  pending,
}: {
  onContinuar: () => void;
  onRecomecar: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-normal text-ink-soft">
        Você tem uma conversa de configuração em andamento. Quer continuar de onde parou?
      </p>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button size="inline" onClick={onContinuar} loading={pending} loadingLabel="Abrindo…">
          Continuar
        </Button>
        <Button size="inline" variant="ghost" onClick={onRecomecar} disabled={pending}>
          Recomeçar do zero
        </Button>
      </div>
    </div>
  );
}

/** Confirmação pós-approve + próximo passo pra TESTAR (item 7). */
function AplicadaCard({
  onReconfigurar,
  pending,
  atendente,
}: {
  onReconfigurar: () => void;
  pending: boolean;
  atendente: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 rounded-[12px] border border-brand/30 bg-brand-soft px-3.5 py-3">
        <span className="mt-0.5 shrink-0 text-brand" aria-hidden>
          <IconSparkle size={17} />
        </span>
        <div>
          <p className="font-display text-[13.5px] font-semibold text-ink">
            Personalidade ativada!
          </p>
          <p className="mt-0.5 text-[12.5px] leading-normal text-ink-soft">
            Seu assistente já responde com a nova personalidade. Você pode reconfigurar quando
            quiser.
          </p>
        </div>
      </div>

      {/* Item 7: próximo passo claro pra o dono validar o bot AGORA. */}
      <div className="rounded-[12px] border border-line bg-surface-sunken px-3.5 py-3">
        <p className="font-display text-[13px] font-semibold text-ink">Como testar agora</p>
        <ol className="mt-1.5 flex list-none flex-col gap-1.5 text-[12.5px] leading-normal text-ink-soft">
          <li>
            <span className="font-semibold text-ink">1.</span> Pegue outro celular (ou peça a
            alguém) e mande um “oi” no WhatsApp do seu negócio.
          </li>
          <li>
            <span className="font-semibold text-ink">2.</span>{' '}
            {atendente
              ? 'Veja se ele responde com o novo jeito e encaminha pra um atendente quando precisar.'
              : 'Veja se ele responde com o novo jeito e confirma antes de marcar um horário.'}
          </li>
        </ol>
      </div>

      <div>
        <Button size="inline" variant="secondary" onClick={onReconfigurar} disabled={pending}>
          Reconfigurar
        </Button>
      </div>
    </div>
  );
}

/** Nota que reforça a garantia da mecânica (não vira responsabilidade do dono). */
function GarantiaNota({ texto }: { texto: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[12px] border border-line bg-surface-sunken px-3.5 py-3 text-ink-soft">
      <span className="mt-0.5 shrink-0 text-brand" aria-hidden>
        <IconSparkle size={15} />
      </span>
      <p className="text-[12.5px] leading-normal">{texto}</p>
    </div>
  );
}

/** Widget de chat: log de bolhas + "digitando" + composer com contador. */
function ChatView({
  messages,
  pending,
  input,
  erroRetry,
  logRef,
  inputRef,
  modo,
  onInput,
  onSubmit,
  onKeyDown,
  onRetry,
  onGerarAgora,
}: {
  messages: BuilderMessage[];
  pending: boolean;
  input: string;
  erroRetry: string | null;
  logRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  modo: BuilderModo;
  onInput: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onRetry: () => void;
  onGerarAgora: () => void;
}) {
  const over = remainingChars(input) < 0;
  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-surface-sunken">
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversa com o assistente de configuração"
        className="flex max-h-[340px] min-h-[180px] flex-col gap-2.5 overflow-y-auto px-3.5 py-4"
      >
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} text={m.text} />
        ))}
        {pending && <TypingBubble />}
        {erroRetry && (
          <div className="flex flex-col items-center gap-2 py-1 text-center">
            <p className="text-[12.5px] text-ink-faint">Tive um probleminha aqui. Tente de novo?</p>
            <button
              type="button"
              onClick={onRetry}
              className="rounded-pill border border-line-strong bg-surface px-4 py-1.5 text-[12.5px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Tentar de novo
            </button>
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-line bg-surface px-2.5 py-2.5">
        <div className="flex items-end gap-2">
          <label htmlFor="monte-assistente-input" className="sr-only">
            Sua resposta
          </label>
          <textarea
            id="monte-assistente-input"
            ref={inputRef}
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={BUILDER_MAX_INPUT + 200}
            disabled={pending}
            enterKeyHint="send"
            placeholder={
              modo === 'melhoria' ? 'Escreva o que quer mudar…' : 'Escreva sua resposta…'
            }
            className="max-h-28 min-h-[42px] min-w-0 flex-1 resize-none rounded-field border border-line-strong bg-surface-sunken px-3.5 py-2.5 text-[15px] leading-snug text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-brand focus:ring-[3px] focus:ring-brand/35 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!isSendable(input, pending)}
            aria-label="Enviar resposta"
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-brand text-bg outline-none transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-95 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:bg-brand/35 disabled:text-ink-faint"
          >
            <IconSend size={18} />
          </button>
        </div>
        <div className="mt-1 flex items-center justify-between px-1">
          <span className="text-[11.5px] text-ink-faint">
            Enter envia · Shift+Enter quebra linha
          </span>
          <span
            aria-live="polite"
            className={cn('tabular-nums text-[11.5px]', over ? 'text-danger' : 'text-ink-faint')}
          >
            {input.length}/{BUILDER_MAX_INPUT}
          </span>
        </div>
      </form>

      {/*
       * "Gerar agora" (SCRUM-92 v3): o dono pode gerar a persona A QUALQUER MOMENTO, sem
       * responder tudo. O backend força a geração neste turno (não depende de o modelo
       * decidir). Fica sempre visível abaixo do composer; depois de gerar, a conversa
       * continua ajustando o rascunho.
       */}
      <div className="border-t border-line bg-surface px-2.5 pb-2.5 pt-2">
        <Button
          size="inline"
          variant="secondary"
          className="w-full"
          onClick={onGerarAgora}
          disabled={pending}
          aria-label="Gerar a personalidade agora com o que você já contou"
        >
          <IconSparkle size={16} />
          Gerar agora
        </Button>
        <p className="mt-1.5 px-1 text-center text-[11.5px] leading-snug text-ink-faint">
          Pode gerar quando quiser — monto com o que você já contou e você continua ajustando
          depois.
        </p>
      </div>
    </div>
  );
}

/** Bolha de chat (assistente = esquerda/surface; dono = direita/brand-soft). */
function Bubble({ role, text }: { role: 'assistant' | 'user'; text: string }) {
  const own = role === 'user';
  return (
    <div className={cn('flex', own ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'chat-bubble-in max-w-[85%] whitespace-pre-wrap break-words rounded-[16px] px-3.5 py-2.5 text-[14px] leading-[1.5]',
          own
            ? 'rounded-br-[5px] bg-brand-soft text-ink'
            : 'rounded-bl-[5px] border border-line bg-surface text-ink',
        )}
      >
        {text}
      </div>
    </div>
  );
}

/** "Digitando…" — 3 pontos com pulso (gated por reduced-motion no globals.css). */
function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div
        className="chat-bubble-in flex items-center gap-1.5 rounded-[16px] rounded-bl-[5px] border border-line bg-surface px-3.5 py-3"
        aria-label="assistente está digitando"
      >
        <span className="typing-dot inline-block size-1.5 rounded-full bg-ink-soft" />
        <span className="typing-dot inline-block size-1.5 rounded-full bg-ink-soft" />
        <span className="typing-dot inline-block size-1.5 rounded-full bg-ink-soft" />
      </div>
    </div>
  );
}

/**
 * Painel de prévia ANCORADO (item 1-2, ordem do Bruno 31/07): nome + resumo + diff
 * verde/vermelho da persona + Salvar/Editar/Rejeitar. Fica visível desde o começo da
 * sessão (não só quando draft_ready) — em melhoria mostra de cara a persona NO AR; em
 * criação mostra um estado vazio honesto até a 1ª prévia existir.
 *
 * Item 3 (preservado): a prévia mostra SÓ a persona pura (diff sobre `personaRascunho`),
 * NÃO o `preview_final` — este inclui o BLOCO_ESTRUTURAL técnico (regras de sistema,
 * nomes de tool) que contradiz "você só cuida da personalidade" e assusta o dono.
 */
function PreviewPanel({
  modo,
  montando,
  resumo,
  nomeBot,
  diffParts,
  verMarcacoes,
  onToggleMarcacoes,
  nota,
  approving,
  salvando,
  podeSalvar,
  onSalvar,
  onEditar,
  editavel,
  onRejeitar,
  onRecomecar,
  onAjustarConversa,
}: {
  modo: BuilderModo;
  /** Ainda não há NENHUM texto de rascunho pra mostrar (nem local, nem do servidor). */
  montando: boolean;
  resumo: string | null;
  nomeBot: string | null;
  diffParts: DiffPart[];
  verMarcacoes: boolean;
  onToggleMarcacoes: () => void;
  nota: string;
  approving: boolean;
  /** "Salvar" disparou generate_now e está aguardando o rascunho voltar (item 3). */
  salvando: boolean;
  /** Sessão já iniciada no backend (ou rascunho pronto) -> "Salvar" pode agir de verdade. */
  podeSalvar: boolean;
  onSalvar: () => void;
  onEditar: () => void;
  /** Rascunho existe -> pode editar/rejeitar. Sem rascunho ainda, essas ações não fazem sentido. */
  editavel: boolean;
  onRejeitar?: () => void;
  onRecomecar: () => void;
  onAjustarConversa: () => void;
}) {
  const temTexto = diffParts.length > 0;
  const houveMudanca = diffParts.some((p) => p.kind !== 'equal');
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-brand/30 bg-brand-soft/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-brand" aria-hidden>
            <IconSparkle size={17} />
          </span>
          <h3 className="font-display text-[14.5px] font-semibold text-ink">
            {modo === 'melhoria' ? 'Seu assistente' : 'Prévia do seu assistente'}
          </h3>
        </div>
        {/* Alternância "ver com marcações / ver texto limpo" — só faz sentido havendo diff. */}
        {temTexto && houveMudanca && (
          <button
            type="button"
            onClick={onToggleMarcacoes}
            className="shrink-0 rounded-pill border border-line-strong bg-surface px-3 py-1 text-[11.5px] font-semibold text-ink-soft outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-brand-soft"
          >
            {verMarcacoes ? 'Ver texto limpo' : 'Ver com marcações'}
          </button>
        )}
      </div>

      {!temTexto ? (
        <p className="text-[13px] leading-normal text-ink-soft" aria-live="polite">
          {montando
            ? 'Montando a prévia…'
            : modo === 'melhoria'
              ? 'Seu texto aparece aqui conforme vocês conversam.'
              : 'Seu texto aparece aqui conforme vocês conversam — responda a primeira pergunta pra começar.'}
        </p>
      ) : (
        <>
          {modo === 'melhoria' && !houveMudanca && (
            <p className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">
              Texto atual
            </p>
          )}
          {/* Item 4: deixa claro que é o nome pelo qual o ASSISTENTE se apresenta, distinto
              do nome do NEGÓCIO (cadastrado em "Meu negócio", logo acima). */}
          {nomeBot && (
            <div className="rounded-[10px] border border-line bg-surface px-3 py-2.5">
              <p className="text-[13px] leading-snug text-ink">
                <span className="text-ink-soft">Seu assistente vai se apresentar como: </span>
                <span className="font-semibold">{nomeBot}</span>
              </p>
              <p className="mt-1 text-[11.5px] leading-snug text-ink-faint">
                É o nome do assistente — diferente do nome do seu negócio.
              </p>
            </div>
          )}
          {resumo && (
            <p className="whitespace-pre-wrap text-[13.5px] leading-normal text-ink">{resumo}</p>
          )}
          <div
            aria-live="polite"
            aria-label={
              houveMudanca && verMarcacoes
                ? 'Texto da personalidade, com o que foi acrescentado e removido marcado'
                : 'Texto da personalidade'
            }
            className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[13px] leading-normal text-ink"
          >
            {verMarcacoes
              ? diffParts.map((p, i) => <DiffSpan key={`${p.kind}-${i}`} part={p} />)
              : diffToPlainText(diffParts)}
          </div>
          <p className="text-[12px] leading-normal text-ink-faint">{nota}</p>
        </>
      )}

      {/* Salvar SEMPRE disponível (item 3, ordem do Bruno): com rascunho -> aprova; sem
          rascunho -> gera agora e aprova no mesmo gesto (a fn decide, o dono só clica). */}
      <div className="mt-1 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
        <Button
          size="inline"
          className="w-full sm:w-auto"
          onClick={onSalvar}
          loading={approving || salvando}
          loadingLabel={salvando ? 'Gerando…' : 'Ativando…'}
          disabled={!podeSalvar}
        >
          Salvar e ativar
        </Button>
        {editavel && (
          <Button
            size="inline"
            variant="secondary"
            className="w-full sm:w-auto"
            onClick={onEditar}
            disabled={approving}
          >
            <IconPencil size={16} />
            Editar
          </Button>
        )}
        {editavel && onRejeitar && (
          <Button
            size="inline"
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={onRejeitar}
            disabled={approving}
          >
            Rejeitar
          </Button>
        )}
      </div>

      {/*
       * Rodapé (SCRUM-92 v3 + item 5): refinar sem recomeçar (a conversa MELHORA o rascunho) e,
       * separado, "Recomeçar do zero" (apaga a entrevista) — cada ação com o seu diálogo próprio.
       */}
      <div className="mt-1 flex flex-col gap-2 border-t border-brand/20 pt-3">
        <p className="text-[12.5px] leading-normal text-ink-soft">
          {modo === 'melhoria'
            ? 'Quer acrescentar, remover ou mudar mais alguma coisa? Continue a conversa que eu ajusto.'
            : 'Quer incluir mais alguma coisa? Continue a conversa que eu ajusto o seu assistente.'}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <button
            type="button"
            onClick={onAjustarConversa}
            disabled={approving}
            className="text-[12.5px] font-semibold text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-brand-soft disabled:opacity-50"
          >
            Continuar a conversa
          </button>
          <button
            type="button"
            onClick={onRecomecar}
            disabled={approving}
            className="text-[12.5px] font-medium text-ink-faint underline-offset-2 outline-none hover:text-danger hover:underline focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-brand-soft disabled:opacity-50"
          >
            Recomeçar do zero
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Um trecho do diff visual. Acessibilidade (item obrigatório): NUNCA depende só de cor —
 * added leva prefixo "+" + sublinhado, removed leva prefixo "−" + tachado. Cada trecho
 * mudado é also um <mark>/<del> semântico (leitor de tela anuncia a mudança).
 */
function DiffSpan({ part }: { part: DiffPart }) {
  if (part.kind === 'equal') return <span>{part.text}</span>;
  if (part.kind === 'added') {
    // Verde = acrescentado. Cor semântica de diff (não é cor de marca) — reforçada com
    // "+"/sublinhado pra não depender só de cor (daltonismo).
    return (
      <mark className="rounded-[3px] bg-emerald-500/15 px-0.5 text-emerald-400 underline decoration-emerald-400/50 decoration-2 underline-offset-2">
        <span aria-hidden>+</span>
        {part.text}
      </mark>
    );
  }
  // Vermelho = removido, sempre com tachado (não só cor).
  return (
    <del className="rounded-[3px] bg-danger-soft px-0.5 text-danger decoration-danger/60">
      <span aria-hidden>−</span>
      {part.text}
    </del>
  );
}

/**
 * Editor da persona (caminho "Editar", melhoria 5): textarea SEMEADA com o rascunho (persona
 * pura, sem o bloco estrutural). Ao salvar => approve com { persona_editada }; o backend re-valida
 * e re-cola a mecânica (confirmação/encaminhamento) — o dono edita só a personalidade, nunca
 * remove a garantia. A `nota` explica isso de forma condicional ao modo do clone.
 */
function EditPersonaPanel({
  value,
  saving,
  nota,
  textareaRef,
  onChange,
  onSalvar,
  onCancelar,
}: {
  value: string;
  saving: boolean;
  nota: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (v: string) => void;
  onSalvar: () => void;
  onCancelar: () => void;
}) {
  const left = personaCharsLeft(value);
  const over = left < 0;
  const savable = isPersonaSavable(value);
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-brand/30 bg-brand-soft/40 p-4">
      <div className="flex items-center gap-2">
        <span className="text-brand" aria-hidden>
          <IconPencil size={16} />
        </span>
        <h3 className="font-display text-[14.5px] font-semibold text-ink">
          Editar a personalidade
        </h3>
      </div>
      <p className="text-[12.5px] leading-normal text-ink-soft">{nota}</p>
      <label htmlFor="monte-assistente-editor" className="sr-only">
        Texto da personalidade do seu assistente
      </label>
      <textarea
        id="monte-assistente-editor"
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        maxLength={PERSONA_MAX_CHARS + 200}
        disabled={saving}
        className="min-h-[220px] w-full resize-y rounded-field border border-line-strong bg-surface px-3.5 py-3 font-sans text-[14px] leading-[1.55] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-brand focus:ring-[3px] focus:ring-brand/35 disabled:opacity-60"
      />
      <div className="flex items-center justify-between">
        <span
          aria-live="polite"
          className={cn('tabular-nums text-[11.5px]', over ? 'text-danger' : 'text-ink-faint')}
        >
          {value.length}/{PERSONA_MAX_CHARS}
        </span>
        {over && (
          <span className="text-[11.5px] font-semibold text-danger">
            Passou do limite — encurte o texto.
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <Button
          size="inline"
          className="w-full sm:w-auto"
          onClick={onSalvar}
          loading={saving}
          loadingLabel="Salvando…"
          disabled={!savable}
        >
          Salvar e ativar
        </Button>
        <Button
          size="inline"
          variant="secondary"
          className="w-full sm:w-auto"
          onClick={onCancelar}
          disabled={saving}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}
