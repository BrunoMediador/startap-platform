'use client';

/**
 * Conectar/Reconectar WhatsApp — reconexao self-service (contrato travado da API,
 * 5 rotas). Uma tela, uma maquina de estados de 9 telas (spec uiux):
 *
 *   b conectado        -> robo no ar; botao discreto "Reconectar mesmo assim".
 *   c desconectado     -> CTA "Reconectar WhatsApp" (+ cooldown anti-abuso).
 *   d reiniciando      -> spinner ~3-20s (timeout 25s -> erro). Poll de status.
 *   e codigo           -> pairing code GIGANTE + passo-a-passo + countdown + poll.
 *   e' codigo_expirado -> code esmaecido + "Gerar novo codigo".
 *   f qr               -> QR em card branco (excecao ao tema) + "outro aparelho".
 *   g sucesso          -> "Conectado!" + voltar pro inicio + toast.
 *   h erro             -> "Tentar de novo" + "Falar com o suporte".
 *   i sem_numero       -> so QR + suporte (sem reconexao por codigo).
 *
 * Polling: GET /status a cada 2s (useStatusConexao), liga so nas fases que
 * esperam transicao (reiniciando/codigo/qr). Para quando terminal. Ao virar
 * WORKING -> sucesso. A transicao final e anunciada via role=status/alert; o
 * poll em si e silencioso pro leitor de tela.
 *
 * Telefone SEMPRE mascarado, SEM campo de edicao (o cliente nao muda o numero).
 */
import {
  IconAlert,
  IconCheck,
  IconCopy,
  IconHeadset,
  IconQr,
  IconRefresh,
  IconWhatsapp,
} from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { PageHead } from '@/components/ui/page-head';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import type { ConexaoResponse } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import {
  useCodigoConexao,
  useConexao,
  useQrConexao,
  useReconectar,
  useStatusConexao,
} from '@/lib/queries';
import { SUPORTE_WHATSAPP_URL } from '@/lib/suporte';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

const PAGE_SUBTITLE =
  'Reconecte o WhatsApp do seu robô sem precisar do suporte. Deixe esta tela aberta durante o processo.';

/** Estados da maquina (a partir do GET inicial + acoes do usuario). */
type Phase =
  | 'conectado'
  | 'desconectado'
  | 'reiniciando'
  | 'codigo'
  | 'codigo_expirado'
  | 'qr'
  | 'sucesso'
  | 'erro'
  | 'sem_numero';

/** Tempo maximo (ms) preso em "reiniciando" sem code nem conexao -> erro. */
const RESTART_TIMEOUT_MS = 25_000;

export function ConectarClient() {
  const { slot } = useTenant();
  const conexaoQ = useConexao(slot);

  // 1. Carregando o GET inicial.
  if (conexaoQ.isPending) {
    return (
      <>
        <PageHead title="Conectar WhatsApp" subtitle={PAGE_SUBTITLE} />
        <span className="sr-only">Carregando o estado da conexão…</span>
        <Skeleton className="h-[220px] w-full rounded-card" />
      </>
    );
  }

  // GET falhou de vez.
  if (conexaoQ.isError || !conexaoQ.data) {
    return (
      <>
        <PageHead title="Conectar WhatsApp" subtitle={PAGE_SUBTITLE} />
        <ErrorState
          title="Não foi possível carregar a conexão"
          onRetry={() => conexaoQ.refetch()}
        />
      </>
    );
  }

  // Feature OFF (flag): tela protegida mesmo via URL direta.
  if (!conexaoQ.data.enabled) {
    return (
      <>
        <PageHead title="Conectar WhatsApp" subtitle={PAGE_SUBTITLE} />
        <EmptyState
          icon={<IconWhatsapp size={26} />}
          title="Reconexão indisponível"
          description="A reconexão pelo portal ainda não está liberada para sua conta. Fale com o suporte se o WhatsApp do seu robô caiu."
          action={{
            label: 'Voltar pro início',
            onClick: () => {
              window.location.href = '/inicio';
            },
          }}
        />
      </>
    );
  }

  // Monta a maquina so com dados garantidos (key pelo slot reseta entre tenants).
  return <ConexaoMachine key={slot} initial={conexaoQ.data} slot={slot} />;
}

function resolveInitialPhase(data: ConexaoResponse): Phase {
  if (data.connected) return 'conectado';
  if (!data.has_registered_phone) return 'sem_numero';
  return 'desconectado';
}

function ConexaoMachine({ initial, slot }: { initial: ConexaoResponse; slot: string }) {
  const toast = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const conexaoQ = useConexao(slot);

  const [phase, setPhase] = useState<Phase>(() => resolveInitialPhase(initial));
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [codeExpiresIn, setCodeExpiresIn] = useState(0);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const [erroMsg, setErroMsg] = useState<string>('');
  // Cooldown anti-abuso do botao "Reconectar" (segundos restantes; 0 = livre).
  const [cooldown, setCooldown] = useState(0);

  const reconectar = useReconectar();
  const gerarCodigo = useCodigoConexao();
  const buscarQr = useQrConexao();

  // Mascara do numero: vem do GET (ou do POST /codigo). So leitura, nunca editavel.
  const phoneMasked = initial.registered_phone_masked;
  const cooldownSeconds = initial.reconnect_cooldown_seconds || 30;

  // Poll de status: ligado nas fases que esperam transicao da sessao.
  const polling = phase === 'reiniciando' || phase === 'codigo' || phase === 'qr';
  const statusQ = useStatusConexao(slot, polling);

  // ── Cooldown tick (1s) ───────────────────────────────────────────────────────
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setInterval(() => setCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [cooldown]);

  // ── Countdown do pairing code (1s); vira expirado em 0 ───────────────────────
  useEffect(() => {
    if (phase !== 'codigo' || codeExpiresIn <= 0) return;
    const id = window.setInterval(() => {
      setCodeExpiresIn((s) => {
        if (s <= 1) {
          setPhase('codigo_expirado');
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, codeExpiresIn]);

  // ── Reage ao poll de status: WORKING -> sucesso; terminal-falho -> erro ──────
  // Para o poll quando `terminal:true` (contrato). connected => sucesso; terminal
  // sem conectar (sessao morreu) => erro com retry. Em codigo/qr o poll roda em
  // paralelo a espera do pareamento; so age na transicao FINAL.
  useEffect(() => {
    if (!polling) return;
    const s = statusQ.data;
    if (!s) return;
    if (s.connected) {
      setPhase('sucesso');
      toast.success('WhatsApp conectado');
      conexaoQ.refetch();
      return;
    }
    if (s.terminal && phase !== 'codigo' && phase !== 'qr') {
      // Estado final sem conexao fora do pareamento ativo -> falha.
      setErroMsg('A conexão demorou demais ou falhou. Isso acontece às vezes.');
      setPhase('erro');
    }
  }, [polling, statusQ.data, phase, toast, conexaoQ]);

  // ── Acoes (definidas antes dos effects que as usam, deps honestas) ───────────

  const irParaSucesso = useCallback(() => {
    setPhase('sucesso');
    toast.success('WhatsApp conectado');
    conexaoQ.refetch();
  }, [toast, conexaoQ]);

  const openQr = useCallback(() => {
    setPhase('qr');
    buscarQr.mutate(undefined, {
      onSuccess: (res) => {
        if (res.connected) {
          irParaSucesso();
          return;
        }
        setQrSrc(res.qr);
      },
      onError: (err) => {
        if (isErr(err, 'sessao_nao_pronta')) {
          // Sessao ainda nao pronta pro QR: volta a reiniciar/esperar.
          setPhase('reiniciando');
          return;
        }
        setErroMsg(mensagemErro(err));
        setPhase('erro');
      },
    });
  }, [buscarQr, irParaSucesso]);

  const gerarNovoCodigo = useCallback(() => {
    gerarCodigo.mutate(undefined, {
      onSuccess: (res) => {
        setPairingCode(res.pairing_code);
        setCodeExpiresIn(res.expires_in_seconds);
        setPhase('codigo');
      },
      onError: (err) => {
        if (isErr(err, 'sessao_nao_pronta')) {
          setPhase('reiniciando');
          return;
        }
        if (isErr(err, 'telefone_nao_cadastrado')) {
          openQr();
          return;
        }
        toast.error(mensagemErro(err));
      },
    });
  }, [gerarCodigo, toast, openQr]);

  const dispararReconexao = useCallback(() => {
    if (cooldown > 0) return;
    setCooldown(cooldownSeconds);
    setPhase('reiniciando');
    reconectar.mutate(undefined, {
      onError: (err) => {
        if (isErr(err, 'ja_conectado')) {
          // Sessao ja subiu sozinha entre o GET e o POST — celebra e ressincroniza.
          irParaSucesso();
          return;
        }
        if (err instanceof ApiError && err.status === 429) {
          const retry = retryAfter(err);
          setCooldown(retry);
          setErroMsg(`Aguarde ${retry}s antes de tentar de novo.`);
          setPhase('erro');
          return;
        }
        setErroMsg(mensagemErro(err));
        setPhase('erro');
      },
    });
  }, [cooldown, cooldownSeconds, reconectar, irParaSucesso]);

  // ── Reiniciando: pede o codigo assim que a sessao ficar pronta; timeout 25s ──
  // Tenta POST /codigo periodicamente. 422 sessao_nao_pronta -> segue esperando.
  // 200 -> entra na tela de codigo. Sem numero cadastrado (422 telefone_*) -> QR.
  const gerarCodigoAsync = gerarCodigo.mutateAsync;
  useEffect(() => {
    if (phase !== 'reiniciando') return;
    const startedAt = Date.now();
    let cancelled = false;
    let timer = 0;

    async function tick(): Promise<void> {
      if (cancelled) return;
      // Timeout de seguranca: preso reiniciando alem do limite -> erro.
      if (Date.now() - startedAt > RESTART_TIMEOUT_MS) {
        setErroMsg('A conexão demorou demais ou falhou. Isso acontece às vezes.');
        setPhase('erro');
        return;
      }
      try {
        const res = await gerarCodigoAsync();
        if (cancelled) return;
        setPairingCode(res.pairing_code);
        setCodeExpiresIn(res.expires_in_seconds);
        setPhase('codigo');
      } catch (err) {
        if (cancelled) return;
        if (isErr(err, 'sessao_nao_pronta')) {
          timer = window.setTimeout(tick, 2000); // ainda preparando — tenta de novo
          return;
        }
        if (isErr(err, 'telefone_nao_cadastrado')) {
          openQr(); // sem numero: cai no caminho de QR
          return;
        }
        setErroMsg(mensagemErro(err)); // 503 ou outro -> erro com retry
        setPhase('erro');
      }
    }
    // Da um respiro inicial pro restart engatar antes do 1o /codigo.
    timer = window.setTimeout(tick, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, gerarCodigoAsync, openQr]);

  // ── Auto-disparo vindo do banner (?auto=1) ───────────────────────────────────
  const autoFired = useRef(false);
  useEffect(() => {
    if (autoFired.current) return;
    if (searchParams.get('auto') !== '1') return;
    autoFired.current = true;
    // Limpa o query param pra um reload nao re-disparar.
    router.replace('/conectar');
    // So auto-dispara se faz sentido (desconectado e com numero).
    if (!initial.connected && initial.has_registered_phone) {
      dispararReconexao();
    }
  }, [searchParams, router, initial, dispararReconexao]);

  // ── Render por fase ───────────────────────────────────────────────────────────
  return (
    <>
      <PageHead title="Conectar WhatsApp" subtitle={PAGE_SUBTITLE} />

      <div className="stagger stagger-2 space-y-3.5">
        {phase === 'conectado' && (
          <ConectadoCard
            phoneMasked={phoneMasked}
            onReconectar={dispararReconexao}
            cooldown={cooldown}
          />
        )}

        {phase === 'desconectado' && (
          <DesconectadoCard
            phoneMasked={phoneMasked}
            onReconectar={dispararReconexao}
            cooldown={cooldown}
            pending={reconectar.isPending}
          />
        )}

        {phase === 'reiniciando' && <ReiniciandoCard />}

        {phase === 'codigo' && pairingCode && (
          <CodigoCard code={pairingCode} expiresIn={codeExpiresIn} onUsarQr={openQr} />
        )}

        {phase === 'codigo_expirado' && pairingCode && (
          <CodigoExpiradoCard
            code={pairingCode}
            onGerarNovo={gerarNovoCodigo}
            gerando={gerarCodigo.isPending}
          />
        )}

        {phase === 'qr' && (
          <QrCard
            src={qrSrc}
            loading={buscarQr.isPending}
            semNumero={!initial.has_registered_phone}
            onAtualizar={openQr}
            onVoltarCodigo={gerarNovoCodigo}
          />
        )}

        {phase === 'sucesso' && <SucessoCard />}

        {phase === 'erro' && (
          <ErroCard mensagem={erroMsg} onTentar={dispararReconexao} cooldown={cooldown} />
        )}

        {phase === 'sem_numero' && <SemNumeroCard onUsarQr={openQr} />}
      </div>
    </>
  );
}

// ── Cards de cada estado ───────────────────────────────────────────────────────

/** (b) Conectado: robo no ar + numero mascarado + reconectar discreto. */
function ConectadoCard({
  phoneMasked,
  onReconectar,
  cooldown,
}: {
  phoneMasked: string | null;
  onReconectar: () => void;
  cooldown: number;
}) {
  return (
    <section className="rounded-card border border-ok/40 bg-ok-soft p-5 shadow-card">
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-full bg-ok">
          <IconCheck size={15} className="text-white" />
        </span>
        <h2 className="font-display text-[17px] font-semibold text-ink">WhatsApp</h2>
      </div>
      <p className="mt-1.5 text-[14px] leading-normal text-ink-soft">
        O robô está conectado e atendendo.
      </p>
      <MaskedPhone phoneMasked={phoneMasked} className="mt-3" />
      <div className="mt-4">
        <Button variant="secondary" size="inline" onClick={onReconectar} disabled={cooldown > 0}>
          {cooldown > 0 ? `Aguarde ${cooldown}s` : 'Reconectar mesmo assim'}
        </Button>
      </div>
    </section>
  );
}

/** (c) Desconectado: CTA primario full + microcopy. */
function DesconectadoCard({
  phoneMasked,
  onReconectar,
  cooldown,
  pending,
}: {
  phoneMasked: string | null;
  onReconectar: () => void;
  cooldown: number;
  pending: boolean;
}) {
  return (
    <section className="rounded-card border border-danger/40 bg-surface p-5 shadow-card">
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-full bg-danger/15 text-danger">
          <IconWhatsapp size={17} />
        </span>
        <h2 className="font-display text-[17px] font-semibold text-ink">
          Seu WhatsApp se desconectou. Vamos reconectar.
        </h2>
      </div>
      <MaskedPhone phoneMasked={phoneMasked} className="mt-3" />
      <div className="mt-4">
        <Button
          onClick={onReconectar}
          disabled={cooldown > 0}
          loading={pending}
          loadingLabel="Reconectando…"
        >
          {cooldown > 0 ? `Aguarde ${cooldown}s` : 'Reconectar WhatsApp'}
        </Button>
      </div>
      <p className="mt-3 text-center text-[12.5px] text-ink-faint">
        Vai levar alguns segundos. Deixe essa tela aberta.
      </p>
    </section>
  );
}

/** (d) Reiniciando: spinner + microcopy. aria-busy + aria-live polite. */
function ReiniciandoCard() {
  return (
    <section
      className="rounded-card border border-line bg-surface p-6 text-center shadow-card"
      aria-busy="true"
      aria-live="polite"
    >
      <span
        className="mx-auto block size-9 rounded-full border-[3px] border-brand border-t-transparent animate-spin-token"
        aria-hidden
      />
      <h2 className="mt-4 font-display text-[17px] font-semibold text-ink">
        Preparando seu WhatsApp…
      </h2>
      <p className="mx-auto mt-1.5 max-w-[34ch] text-[14px] leading-normal text-ink-soft">
        Isso leva de 3 a 20 segundos. Não feche essa tela.
      </p>
    </section>
  );
}

/** (e) Codigo: code GIGANTE + copiar + countdown + passo-a-passo + link QR. */
function CodigoCard({
  code,
  expiresIn,
  onUsarQr,
}: {
  code: string;
  expiresIn: number;
  onUsarQr: () => void;
}) {
  return (
    <>
      <section className="rounded-card border border-line bg-surface p-5 shadow-card">
        <h2 className="font-display text-[17px] font-semibold text-ink">
          Cole esse código no seu WhatsApp.
        </h2>
        <GiantCode code={code} />
        <div className="mt-3.5">
          <CopyCodeButton code={code} />
        </div>
        <Countdown seconds={expiresIn} />

        {/* Status passivo do poll — anuncia "esperando" sem spam de leitor de tela. */}
        <p className="mt-3 flex items-center justify-center gap-2 text-[13px] text-ink-soft">
          <span className="size-2 animate-pulse rounded-full bg-brand" aria-hidden />
          Esperando você conectar…
        </p>
      </section>

      <PassoAPasso />

      <div className="text-center">
        <button
          type="button"
          onClick={onUsarQr}
          className="text-[13px] font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          Prefere o QR? Usar QR Code
        </button>
      </div>
    </>
  );
}

/** (e') Codigo expirado: code esmaecido + "Gerar novo codigo". */
function CodigoExpiradoCard({
  code,
  onGerarNovo,
  gerando,
}: {
  code: string;
  onGerarNovo: () => void;
  gerando: boolean;
}) {
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-card">
      <h2 className="font-display text-[17px] font-semibold text-ink">Código expirado</h2>
      <div className="pointer-events-none select-none opacity-40">
        <GiantCode code={code} muted />
      </div>
      <p className="mt-1 text-center text-[13.5px] text-ink-soft">
        Código expirado. Gere um novo pra continuar.
      </p>
      <div className="mt-4">
        <Button onClick={onGerarNovo} loading={gerando} loadingLabel="Gerando…">
          Gerar novo código
        </Button>
      </div>
    </section>
  );
}

/** (f) QR: card de FUNDO BRANCO (excecao ao tema, QR nao le no escuro). */
function QrCard({
  src,
  loading,
  semNumero,
  onAtualizar,
  onVoltarCodigo,
}: {
  src: string | null;
  loading: boolean;
  semNumero: boolean;
  onAtualizar: () => void;
  onVoltarCodigo: () => void;
}) {
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-full bg-brand-soft text-brand">
          <IconQr size={17} />
        </span>
        <h2 className="font-display text-[17px] font-semibold text-ink">
          Leia o QR com outro celular.
        </h2>
      </div>

      <div className="mt-4 flex justify-center">
        {loading || !src ? (
          <Skeleton className="size-56 rounded-card-sm" />
        ) : (
          // Card de fundo BRANCO: excecao deliberada ao tema escuro (mesmo
          // tratamento do QR PIX) — QR nao e legivel sobre fundo escuro.
          <Image
            src={src}
            alt="QR Code para conectar o WhatsApp do robô"
            width={224}
            height={224}
            unoptimized
            className="size-56 rounded-card-sm border border-line bg-white p-2"
          />
        )}
      </div>

      <p className="mt-3 rounded-card-sm border border-line bg-bg px-3 py-2.5 text-[13px] leading-snug text-ink-soft">
        Você precisa de <b className="text-ink">outro aparelho</b> pra ler o QR. No seu próprio
        celular, use o código.
      </p>

      <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
        <Button
          variant="secondary"
          size="inline"
          onClick={onAtualizar}
          loading={loading}
          loadingLabel="Atualizando…"
        >
          <IconRefresh size={18} />
          Atualizar QR
        </Button>
        {!semNumero && (
          <Button variant="ghost" size="inline" onClick={onVoltarCodigo}>
            Voltar pro código
          </Button>
        )}
      </div>
    </section>
  );
}

/** (g) Sucesso: circulo ok + voltar pro inicio. role=status anuncia. */
function SucessoCard() {
  return (
    <section
      className="rounded-card border border-ok/40 bg-ok-soft p-6 text-center shadow-card"
      role="status"
    >
      <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-ok">
        <IconCheck size={28} className="text-white" />
      </span>
      <h2 className="mt-4 font-display text-[19px] font-semibold text-ink">Conectado! 🎉</h2>
      <p className="mx-auto mt-1.5 max-w-[34ch] text-[14px] leading-normal text-ink-soft">
        Seu robô já está atendendo no WhatsApp.
      </p>
      <div className="mx-auto mt-5 max-w-[260px]">
        <Button
          onClick={() => {
            window.location.href = '/inicio';
          }}
        >
          Voltar pro início
        </Button>
      </div>
    </section>
  );
}

/** (h) Erro/timeout: tentar de novo + falar com o suporte. role=alert. */
function ErroCard({
  mensagem,
  onTentar,
  cooldown,
}: {
  mensagem: string;
  onTentar: () => void;
  cooldown: number;
}) {
  return (
    <section
      className="rounded-card border border-danger/40 bg-surface p-5 shadow-card"
      role="alert"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-full bg-danger text-white">
          <IconAlert size={15} />
        </span>
        <h2 className="font-display text-[17px] font-semibold text-ink">
          Não conseguimos reconectar
        </h2>
      </div>
      <p className="mt-1.5 text-[14px] leading-normal text-ink-soft">
        {mensagem || 'A conexão demorou demais ou falhou. Isso acontece às vezes.'} Vamos tentar de
        novo.
      </p>
      <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
        <Button onClick={onTentar} disabled={cooldown > 0}>
          {cooldown > 0 ? `Aguarde ${cooldown}s` : 'Tentar de novo'}
        </Button>
        <SuporteLink variant="secondary" />
      </div>
    </section>
  );
}

/** (i) Sem numero: so QR + suporte. SEM campo de numero. */
function SemNumeroCard({ onUsarQr }: { onUsarQr: () => void }) {
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-full bg-amber-soft text-amber">
          <IconAlert size={15} />
        </span>
        <h2 className="font-display text-[17px] font-semibold text-ink">Número não cadastrado</h2>
      </div>
      <p className="mt-1.5 text-[14px] leading-normal text-ink-soft">
        Ainda não temos o número do seu WhatsApp cadastrado. Por isso, a reconexão por código não
        está disponível. Você pode conectar pelo QR ou pedir pra nossa equipe cadastrar o número.
      </p>
      <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
        <Button onClick={onUsarQr}>
          <IconQr size={18} />
          Conectar pelo QR
        </Button>
        <SuporteLink variant="secondary" />
      </div>
    </section>
  );
}

// ── Sub-componentes compartilhados ─────────────────────────────────────────────

/** Numero mascarado do robo (so leitura). Nunca editavel. */
function MaskedPhone({
  phoneMasked,
  className,
}: {
  phoneMasked: string | null;
  className?: string;
}) {
  if (!phoneMasked) return null;
  return (
    <p className={cn('text-[13.5px] text-ink-soft', className)}>
      Número do robô:{' '}
      <span className="font-semibold tabular-nums tracking-wide text-ink">{phoneMasked}</span>
    </p>
  );
}

/**
 * Código GIGANTE, selecionavel. aria-label dígito a dígito (leitor le "8, 4, 2,
 * 9, ... 3, 1, 7, 5") em vez de "oito mil..."; o hífen fica VISÍVEL e é anunciado
 * como "hífen". Inter com tabular-nums + tracking largo (sem fonte mono local — a
 * spec do projeto proíbe next/font/google e não há mono vendorada).
 */
function GiantCode({ code, muted = false }: { code: string; muted?: boolean }) {
  const aria = code
    .split('')
    .map((ch) => (ch === '-' ? 'hífen' : ch))
    .join(', ');
  return (
    <output
      aria-label={`Código de conexão: ${aria}`}
      className={cn(
        'mt-4 block select-all text-center font-display text-[clamp(36px,11vw,52px)] font-bold leading-none tabular-nums tracking-[0.12em]',
        muted ? 'text-ink-soft' : 'text-ink',
      )}
    >
      {code}
    </output>
  );
}

/** Botao copiar com feedback TEXTUAL + aria-live (nao so cor). */
function CopyCodeButton({ code }: { code: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Não foi possível copiar. Selecione o código manualmente.');
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={onCopy}>
        {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
        {copied ? '✓ Copiado!' : 'Copiar código'}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Código copiado para a área de transferência.' : ''}
      </span>
    </>
  );
}

/** Contador "Expira em 0:48" — vira amber abaixo de 15s. */
function Countdown({ seconds }: { seconds: number }) {
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  const urgente = seconds < 15;
  return (
    <p
      className={cn(
        'mt-3 text-center text-[13px] font-semibold tabular-nums',
        urgente ? 'text-amber' : 'text-ink-faint',
      )}
      aria-live="off"
    >
      Expira em {mm}:{ss}
    </p>
  );
}

/** Passo-a-passo numerado pra colar o código no WhatsApp do celular do robô. */
function PassoAPasso() {
  const passos = [
    'Abra o WhatsApp no celular do robô',
    "Toque em Ajustes (⚙️) e depois em 'Aparelhos conectados'",
    "Toque em 'Conectar um aparelho'",
    "Toque em 'Conectar com número de telefone' (fica embaixo do leitor de QR)",
    'Digite ou cole o código que aparece aqui em cima',
  ];
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-card">
      <h3 className="font-display text-[14px] font-semibold text-ink">Como conectar</h3>
      <ol className="mt-3 space-y-2.5">
        {passos.map((texto, i) => (
          <li key={texto} className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft font-display text-[12px] font-bold text-brand"
            >
              {i + 1}
            </span>
            <span className="text-[13.5px] leading-snug text-ink-soft">
              <span className="sr-only">Passo {i + 1}: </span>
              {texto}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Link "Falar com o suporte" (wa.me) com alvo >=44px. */
function SuporteLink({ variant = 'secondary' }: { variant?: 'secondary' | 'ghost' }) {
  return (
    <a
      href={SUPORTE_WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex h-11 w-full items-center justify-center gap-2 rounded-btn px-5 font-display text-[15px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:w-auto',
        variant === 'secondary'
          ? 'border border-line-strong bg-surface text-brand hover:bg-surface-hover'
          : 'text-brand hover:bg-brand-soft',
      )}
    >
      <IconHeadset size={18} />
      Falar com o suporte
    </a>
  );
}

// ── Helpers de erro do contrato ────────────────────────────────────────────────

/** Casa um erro do contrato (corpo { error: '...' }) pelo nome. */
function isErr(err: unknown, name: string): boolean {
  return (
    err instanceof ApiError &&
    typeof err.body === 'object' &&
    err.body !== null &&
    (err.body as { error?: unknown }).error === name
  );
}

/** retry_after_seconds do 429 (aguarde), com fallback 30s. */
function retryAfter(err: ApiError): number {
  if (typeof err.body === 'object' && err.body !== null) {
    const v = (err.body as { retry_after_seconds?: unknown }).retry_after_seconds;
    if (typeof v === 'number' && v > 0) return Math.ceil(v);
  }
  return 30;
}

/** Mensagem amigavel (sem jargao) pra erros gerais das rotas de conexao. */
function mensagemErro(err: unknown): string {
  if (err instanceof ApiError) {
    if (isErr(err, 'waha_indisponivel') || err.status === 503) {
      return 'O serviço de conexão está indisponível no momento.';
    }
    if (err.status === 0) return 'Sem conexão. Verifique sua internet e tente de novo.';
  }
  return 'A conexão demorou demais ou falhou. Isso acontece às vezes.';
}
