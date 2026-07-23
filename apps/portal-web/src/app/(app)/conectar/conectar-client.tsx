'use client';

/**
 * Conectar/Reconectar WhatsApp — reconexao self-service (contrato travado da API,
 * 5 rotas). Uma tela, uma maquina de estados de 9 telas (spec uiux):
 *
 *   b conectado        -> robo no ar; botao discreto "Reconectar mesmo assim".
 *   c desconectado     -> CTA "Reconectar WhatsApp" (+ cooldown anti-abuso).
 *   d reiniciando      -> spinner (timeout 45s -> erro). Poll de status.
 *   e codigo           -> pairing code GIGANTE + passo-a-passo + countdown + poll.
 *   e' codigo_expirado -> code esmaecido + "Gerar novo codigo".
 *   f qr               -> QR em card branco (excecao ao tema) + "outro aparelho".
 *   g sucesso          -> "Conectado!" + voltar pro inicio + toast.
 *   h erro             -> "Tentar de novo" + "Falar com o suporte".
 *   i sem_numero       -> so QR + suporte (sem reconexao por codigo).
 *
 * Polling: GET /status a cada 2s (useStatusConexao), liga so nas fases que
 * esperam transicao (reiniciando/codigo/qr). Para quando terminal. Ao virar
 * WORKING -> sucesso. E o poll de STATUS que decide quando pedir o codigo: em
 * 'reiniciando', assim que o status reporta SCAN_QR_CODE, POST /codigo e
 * disparado UMA unica vez. O /codigo tem rate-limit apertado (3 por 5min,
 * dimensionado pra clique manual em "Gerar novo codigo") e NUNCA pode virar
 * polling — era isso que estourava 429 e derrubava a tela em ~7s em prod.
 * A transicao final e anunciada via role=status/alert; o poll em si e
 * silencioso pro leitor de tela.
 *
 * Telefone SEMPRE mascarado, SEM campo de edicao (o cliente nao muda o numero).
 */
import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconCopy,
  IconHeadset,
  IconLock,
  IconPause,
  IconPlay,
  IconQr,
  IconRefresh,
  IconWhatsapp,
} from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHead } from '@/components/ui/page-head';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import type { ConexaoResponse } from '@/lib/api-types';
import {
  MSG_SUSPENSAO_STARTAP,
  type PausaEstado,
  isAtendimentoLigado,
  isPausaFeatureOff,
  isPausaTravada,
  resolvePausaEstado,
} from '@/lib/bot-pausa';
import { cn } from '@/lib/cn';
import { isPrimeiraConexao, resolveConexaoCardCopy } from '@/lib/conexao-copy';
import {
  type SucessoConexaoCopy,
  resolveConexaoFormato,
  sucessoConexaoCopy,
} from '@/lib/conexao-sucesso';
import {
  useAgendaConfig,
  useCodigoConexao,
  useConexao,
  usePausarBot,
  useQrConexao,
  useReconectar,
  useRetomarBot,
  useStatusConexao,
} from '@/lib/queries';
import { SUPORTE_WHATSAPP_URL } from '@/lib/suporte';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

const PAGE_SUBTITLE =
  'Reconecte o WhatsApp do seu assistente sem precisar do suporte. Deixe esta tela aberta durante o processo.';

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

/**
 * Tempo maximo (ms) preso em "reiniciando" sem code nem conexao -> erro.
 * Folga confortavel ACIMA do orcamento do backend (restartAndWaitForScan usa
 * totalTimeoutMs: 30_000): reiniciar uma sessao HARD-desconectada leva ~25-30s
 * (Baileys regera o pareamento do zero). 25s desistia bem quando a sessao tinha
 * acabado de ficar pronta (falso negativo, confirmado em prod). 45s cobre isso.
 */
const RESTART_TIMEOUT_MS = 45_000;

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
          description="A reconexão pelo portal ainda não está liberada para sua conta. Fale com o suporte se o WhatsApp do seu assistente caiu."
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
  // Formato do clone (agenda vs modo atendente) — decide a copy do card de sucesso
  // (item-6). Leitura leve/cacheada do perfil; enquanto não resolve, o resolvedor
  // degrada pra 'agenda' (comportamento atual, byte-idêntico).
  const agendaCfgQ = useAgendaConfig(slot);
  const sucessoCopy = sucessoConexaoCopy(resolveConexaoFormato(agendaCfgQ.data));

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
    if (s.terminal && phase !== 'codigo' && phase !== 'qr' && phase !== 'reiniciando') {
      // Estado final sem conexao fora do pareamento ativo -> falha.
      // 'reiniciando' tambem fica de fora: durante o restart a sessao pode passar
      // transitoriamente por FAILED/STOPPED antes de STARTING -> SCAN_QR_CODE.
      // Tratar isso como erro imediato e um falso negativo — a autoridade de
      // desistir no restart e o timeout de seguranca de 45s (effect abaixo).
      // connected -> sucesso segue valendo em qualquer fase (tratado acima).
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

  // ── "Latest ref" do openQr ────────────────────────────────────────────────────
  // O effect do código (abaixo) NÃO pode capturar `openQr` direto: openQr depende
  // de irParaSucesso -> conexaoQ (objeto react-query cuja IDENTIDADE muda a cada
  // poll/render). Capturar openQr nas deps já causou bug em prod (PR #262: effect
  // re-executava a cada poll, o cleanup cancelava o request em voo e DESCARTAVA
  // um código 200 válido -> loop infinito preso em "Preparando"). Aqui o effect
  // lê SEMPRE a versão mais recente via ref, mantendo deps deliberadas.
  const openQrRef = useRef(openQr);
  useEffect(() => {
    openQrRef.current = openQr;
  }, [openQr]);

  // ── Reiniciando: timeout de seguranca (preso alem de 45s -> erro) ────────────
  // Quem espera a sessao ficar pronta e o poll de GET /status (60/min). Aqui so
  // o teto do ciclo: sem codigo nem conexao dentro do budget, desiste.
  useEffect(() => {
    if (phase !== 'reiniciando') return;
    const timer = window.setTimeout(() => {
      setErroMsg('A conexão demorou demais ou falhou. Isso acontece às vezes.');
      setPhase('erro');
    }, RESTART_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // ── Reiniciando: pede o codigo UMA vez quando o status vira SCAN_QR_CODE ─────
  // POST /codigo tem rate-limit 3/5min (dimensionado pra clique manual em "Gerar
  // novo código") e NUNCA pode virar polling: o tick-loop antigo queimava a cota
  // com 422 sessao_nao_pronta e o 4o tick levava 429 -> erro genérico em ~7s
  // (bug de prod; o código nunca aparecia). O gatilho agora é o poll de /status:
  // SCAN_QR_CODE -> dispara o POST uma única vez por ciclo.
  //
  // Guard temporal via ref (não duplo-dispara entre renders/polls): guarda o
  // dataUpdatedAt do tick de /status já tratado; Infinity = código pedido (trava
  // o ciclo). Na corrida rara do 422 (status mudou entre o poll e o POST), rearma
  // pro PRÓXIMO tick novo de /status — não conta como erro. Deps deliberadas:
  // phase + dado/timestamp do poll + mutateAsync (identidade estável no TanStack
  // Query). Sem cleanup cancelando nada: re-render é inofensivo (lição do #262).
  const gerarCodigoAsync = gerarCodigo.mutateAsync;
  const statusTratadoRef = useRef(0);
  useEffect(() => {
    if (phase !== 'reiniciando') {
      statusTratadoRef.current = 0; // fora do ciclo -> libera pro próximo
      return;
    }
    const tick = statusQ.dataUpdatedAt;
    if (statusQ.data?.status !== 'SCAN_QR_CODE') return;
    if (tick <= statusTratadoRef.current) return; // já tratado ou travado
    statusTratadoRef.current = Number.POSITIVE_INFINITY; // 1 POST por ciclo

    void (async () => {
      try {
        const res = await gerarCodigoAsync();
        // NUNCA descartar um código 200 válido: o backend já emitiu o pareamento
        // (efêmero, 60s) e re-pedir geraria spam. Aplica SEMPRE, mesmo que a fase
        // tenha mudado durante o await — um setState a mais é inofensivo (React
        // no-op fora de tela); jogar o código fora é o bug (lição do PR #262).
        setPairingCode(res.pairing_code);
        setCodeExpiresIn(res.expires_in_seconds);
        setPhase('codigo');
      } catch (err) {
        if (isErr(err, 'sessao_nao_pronta')) {
          // Corrida rara: a sessao saiu de SCAN_QR_CODE entre o poll e o POST.
          // Rearma o guard pro proximo tick de /status tentar de novo.
          statusTratadoRef.current = tick;
          return;
        }
        if (isErr(err, 'telefone_nao_cadastrado')) {
          openQrRef.current(); // sem numero: cai no caminho de QR (ref estável)
          return;
        }
        if (err instanceof ApiError && err.status === 429) {
          // Cota do /codigo queimada (ex.: cliques manuais recentes em "Gerar
          // novo código"). NÃO vira erro genérico: segue esperando dentro do
          // budget de 45s (timeout acima decide). Guard fica travado pra não
          // martelar o endpoint de novo neste ciclo.
          return;
        }
        setErroMsg(mensagemErro(err)); // 503 ou outro -> erro com retry
        setPhase('erro');
      }
    })();
  }, [phase, statusQ.data, statusQ.dataUpdatedAt, gerarCodigoAsync]);

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
        {/* Pausa do atendimento (eixo SEPARADO da reconexao WAHA). Aparece
            independente da fase de conexao — um robo pode estar conectado E
            pausado. Some sozinho quando a flag PORTAL_BOT_PAUSE esta OFF (o GET
            nao expoe os campos). */}
        <PausaCard slot={slot} conexao={conexaoQ.data ?? initial} />

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
            everConnected={initial.ever_connected}
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

        {phase === 'sucesso' && <SucessoCard copy={sucessoCopy} />}

        {phase === 'erro' && (
          <ErroCard mensagem={erroMsg} onTentar={dispararReconexao} cooldown={cooldown} />
        )}

        {phase === 'sem_numero' && <SemNumeroCard onUsarQr={openQr} />}
      </div>
    </>
  );
}

// ── Card de PAUSA do atendimento (eixo flow_enabled, separado da conexao WAHA) ──

/**
 * Card de pausar/retomar o atendimento automatico. SEPARADO da maquina de
 * reconexao WAHA (sao eixos diferentes: WAHA=conexao; flow_enabled=pausa). Aparece
 * independente do estado de conexao. 3 estados (do GET /portal/conexao):
 *   ativo            -> "Pausar atendimento" (ConfirmDialog -> POST /bot/pause).
 *   pausado_self     -> "Retomar atendimento" (POST /bot/resume).
 *   pausado_startap  -> toggle TRAVADO + badge "Pausado pela Startap" + suporte.
 * Com a flag PORTAL_BOT_PAUSE OFF (campos ausentes no GET) o card NAO renderiza.
 *
 * "atendimento"/"robo" na copy de proposito (PME nao fala "bot").
 */
function PausaCard({ slot, conexao }: { slot: string; conexao: ConexaoResponse }) {
  const toast = useToast();
  const pausar = usePausarBot(slot);
  const retomar = useRetomarBot(slot);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Flag OFF -> backend nao expoe os campos -> esconde o card (degrada limpo).
  if (isPausaFeatureOff(conexao)) return null;

  const estado = resolvePausaEstado(conexao);
  const ligado = isAtendimentoLigado(estado);
  const travado = isPausaTravada(estado);
  const ocupado = pausar.isPending || retomar.isPending;

  function onToggle(next: boolean) {
    if (travado || ocupado) return;
    if (!next) {
      // Ligado -> desligar: confirma antes (acao com efeito no WhatsApp do cliente).
      setConfirmOpen(true);
      return;
    }
    // Desligado -> ligar: retoma direto.
    retomar.mutate(undefined, {
      onSuccess: () => toast.success('Atendimento retomado'),
      onError: (err) => toast.error(mensagemResume(err)),
    });
  }

  function confirmarPausa() {
    pausar.mutate(undefined, {
      onSuccess: () => {
        setConfirmOpen(false);
        toast.success('Atendimento pausado');
      },
      onError: (err) => {
        setConfirmOpen(false);
        toast.error(mensagemErro(err));
      },
    });
  }

  return (
    <PausaCardView
      estado={estado}
      ligado={ligado}
      travado={travado}
      ocupado={ocupado}
      onToggle={onToggle}
      onRetomar={() =>
        retomar.mutate(undefined, {
          onSuccess: () => toast.success('Atendimento retomado'),
          onError: (err) => toast.error(mensagemResume(err)),
        })
      }
      confirmOpen={confirmOpen}
      onConfirm={confirmarPausa}
      onCancelConfirm={() => setConfirmOpen(false)}
      confirmando={pausar.isPending}
    />
  );
}

/**
 * Apresentacao PURA do card de pausa (sem hooks de dados) — facil de testar e
 * reusar. Recebe o estado ja resolvido por @/lib/bot-pausa.
 */
function PausaCardView({
  estado,
  ligado,
  travado,
  ocupado,
  onToggle,
  onRetomar,
  confirmOpen,
  onConfirm,
  onCancelConfirm,
  confirmando,
}: {
  estado: PausaEstado;
  ligado: boolean;
  travado: boolean;
  ocupado: boolean;
  onToggle: (next: boolean) => void;
  onRetomar: () => void;
  confirmOpen: boolean;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  confirmando: boolean;
}) {
  return (
    <section
      className="rounded-card border border-line bg-surface p-5 shadow-card"
      aria-labelledby="pausa-titulo"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'flex size-7 items-center justify-center rounded-full',
              ligado ? 'bg-ok-soft text-ok' : 'bg-amber-soft text-amber',
            )}
          >
            {ligado ? <IconPlay size={15} /> : <IconPause size={15} />}
          </span>
          <h2 id="pausa-titulo" className="font-display text-[17px] font-semibold text-ink">
            Atendimento automático
          </h2>
        </div>

        {travado ? (
          <Badge tone="amber">
            <IconLock size={12} />
            Pausado pela Startap
          </Badge>
        ) : (
          <Switch
            checked={ligado}
            onChange={onToggle}
            disabled={ocupado}
            label="Atendimento automático ligado"
          />
        )}
      </div>

      <p className="mt-2.5 text-[14px] leading-normal text-ink-soft">
        {estado === 'ativo' && 'O assistente está respondendo no WhatsApp.'}
        {estado === 'pausado_self' &&
          'O assistente não responde até você retomar. O WhatsApp continua conectado.'}
        {estado === 'pausado_startap' &&
          'O atendimento está pausado pela Startap. Fale com o suporte pra reativar.'}
      </p>

      {/* Acao por estado: pausado-por-voce -> "Retomar"; travado -> suporte. */}
      {estado === 'pausado_self' && (
        <div className="mt-4">
          <Button onClick={onRetomar} loading={ocupado} loadingLabel="Retomando…">
            <IconPlay size={18} />
            Retomar atendimento
          </Button>
        </div>
      )}

      {estado === 'pausado_startap' && (
        <div className="mt-4">
          <SuporteLink variant="secondary" />
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Pausar o atendimento?"
        description="O assistente vai parar de responder até você retomar. O WhatsApp continua conectado."
        confirmLabel="Pausar atendimento"
        confirmVariant="destructive"
        loading={confirmando}
        icon={<IconPause size={22} />}
        onConfirm={onConfirm}
        onCancel={onCancelConfirm}
      />
    </section>
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
        O assistente está conectado e atendendo.
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

/**
 * (c) Desconectado: CTA primario full + microcopy.
 *
 * Duas molduras conforme a historia de pareamento do clone (SCRUM-95), decididas
 * pelo modulo puro @/lib/conexao-copy a partir de `everConnected`:
 *   - RECONEXAO (ja pareou e caiu, ou sinal AUSENTE = default seguro): copy e tom
 *     vermelho VIGENTES, byte-identicos (tem cliente pagante em producao).
 *   - PRIMEIRA conexao (nunca pareou): copy positiva de onboarding + tom de marca
 *     (nada quebrou). So a moldura muda — a acao (restart -> pareamento) e a mesma.
 */
function DesconectadoCard({
  phoneMasked,
  onReconectar,
  cooldown,
  pending,
  everConnected,
}: {
  phoneMasked: string | null;
  onReconectar: () => void;
  cooldown: number;
  pending: boolean;
  everConnected: boolean | undefined;
}) {
  const copy = resolveConexaoCardCopy(everConnected);
  const primeira = isPrimeiraConexao(everConnected);
  // Literais completos por ramo (nao cn/twMerge) pra garantir o byte-identico da
  // reconexao. Primeira conexao troca o vermelho de "desconectou" por tom de marca.
  const sectionCls = primeira
    ? 'rounded-card border border-brand/40 bg-surface p-5 shadow-card'
    : 'rounded-card border border-danger/40 bg-surface p-5 shadow-card';
  const iconCls = primeira
    ? 'flex size-7 items-center justify-center rounded-full bg-brand-soft text-brand'
    : 'flex size-7 items-center justify-center rounded-full bg-danger/15 text-danger';
  return (
    <section className={sectionCls}>
      <div className="flex items-center gap-2.5">
        <span className={iconCls}>
          <IconWhatsapp size={17} />
        </span>
        <h2 className="font-display text-[17px] font-semibold text-ink">{copy.title}</h2>
      </div>
      <MaskedPhone phoneMasked={phoneMasked} className="mt-3" />
      <div className="mt-4">
        <Button
          onClick={onReconectar}
          disabled={cooldown > 0}
          loading={pending}
          loadingLabel={copy.ctaLoading}
        >
          {cooldown > 0 ? `Aguarde ${cooldown}s` : copy.cta}
        </Button>
      </div>
      <p className="mt-3 text-center text-[12.5px] text-ink-faint">{copy.hint}</p>
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
        Isso leva alguns segundos. Não feche essa tela.
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
        <p className="mt-2 text-center text-[12.5px] leading-snug text-ink-faint">
          Copie antes de abrir o WhatsApp — lá é só colar.
        </p>
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
            alt="QR Code para conectar o WhatsApp do assistente"
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
          loadingLabel="Gerando…"
        >
          <IconRefresh size={18} />
          Gerar um novo código
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

/**
 * (g) Sucesso: circulo ok + voltar pro inicio. role=status anuncia. A copy vem do
 * FORMATO do clone (item-6): clone COM agenda vê "Falta só a sua agenda"; modo
 * atendente (sem agenda) não vê esse bloco — já está tudo no ar. `copy.agenda` null
 * = esconde o bloco. Default seguro = 'agenda' (ver lib/conexao-sucesso).
 */
function SucessoCard({ copy }: { copy: SucessoConexaoCopy }) {
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
        {copy.subtitulo}
      </p>

      {/* Próximo passo (SÓ clone com agenda): a agenda (Google Calendar) é configurada
          pela equipe, não é self-service. Modo atendente não usa agenda -> some. */}
      {copy.agenda && (
        <div className="mx-auto mt-5 flex max-w-[420px] items-start gap-3 rounded-card-sm border border-brand/30 bg-brand-soft p-4 text-left">
          <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-bg">
            <IconCalendar size={16} />
          </span>
          <div>
            <p className="font-display text-[14px] font-semibold text-ink">{copy.agenda.titulo}</p>
            <p className="mt-1 text-[13.5px] leading-snug text-ink-soft">{copy.agenda.texto}</p>
          </div>
        </div>
      )}

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
      Número do assistente:{' '}
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

/** Um passo do tutorial. `key` estável (a lista troca por plataforma). */
type Passo = { key: string; texto: ReactNode };

/** Plataforma do celular do robô — o menu do WhatsApp muda entre as duas. */
type Plataforma = 'android' | 'iphone';

/**
 * Tutorial à prova de leigo pra colar o código no WhatsApp do celular do robô.
 * O cliente costuma abrir o portal NO PRÓPRIO celular do robô, então:
 *  1. Caminho feliz em destaque: gerar o código dispara uma notificação push do
 *     WhatsApp NESTE aparelho ("conectar novo aparelho") -> tocar nela e colar.
 *  2. Fallback manual separado por plataforma (Android usa ⋮ no topo; iPhone usa
 *     Configurações embaixo) — toggle simples, sem lib nova.
 *  3. Reforço de copiar o código ANTES de trocar de app (vai sair desta tela).
 */
function PassoAPasso() {
  const [plataforma, setPlataforma] = useState<Plataforma>('android');

  const passosNotificacao: Passo[] = [
    {
      key: 'copiar',
      texto: (
        <>
          Toque em <b className="text-ink">Copiar código</b> aqui em cima.
        </>
      ),
    },
    {
      key: 'notificacao',
      texto: (
        <>
          Toque na <b className="text-ink">notificação do WhatsApp</b> quando ela aparecer.
        </>
      ),
    },
    { key: 'colar', texto: 'Cole o código. Pronto!' },
  ];

  const passosManual: Record<Plataforma, Passo[]> = {
    android: [
      {
        key: 'copiar',
        texto: (
          <>
            <b className="text-ink">Copie o código</b> aqui em cima.
          </>
        ),
      },
      { key: 'abrir', texto: 'Abra o WhatsApp.' },
      {
        key: 'menu',
        texto: (
          <>
            Toque nos <b className="text-ink">três pontinhos (⋮)</b> no canto de cima, à direita.
          </>
        ),
      },
      {
        key: 'aparelhos',
        texto: (
          <>
            Toque em <b className="text-ink">Aparelhos conectados</b>.
          </>
        ),
      },
      {
        key: 'conectar',
        texto: (
          <>
            Toque em <b className="text-ink">Conectar um aparelho</b>.
          </>
        ),
      },
      {
        key: 'numero',
        texto: (
          <>
            Toque em <b className="text-ink">Conectar com número de telefone</b> — fica embaixo do
            leitor de QR.
          </>
        ),
      },
      { key: 'colar', texto: 'Cole o código. Pronto!' },
    ],
    iphone: [
      {
        key: 'copiar',
        texto: (
          <>
            <b className="text-ink">Copie o código</b> aqui em cima.
          </>
        ),
      },
      { key: 'abrir', texto: 'Abra o WhatsApp.' },
      {
        key: 'menu',
        texto: (
          <>
            Toque em <b className="text-ink">Configurações</b>, no canto de baixo, à direita.
          </>
        ),
      },
      {
        key: 'aparelhos',
        texto: (
          <>
            Toque em <b className="text-ink">Aparelhos conectados</b>.
          </>
        ),
      },
      {
        key: 'conectar',
        texto: (
          <>
            Toque em <b className="text-ink">Conectar um aparelho</b>.
          </>
        ),
      },
      {
        key: 'numero',
        texto: (
          <>
            Toque em <b className="text-ink">Conectar com número de telefone</b>.
          </>
        ),
      },
      { key: 'colar', texto: 'Cole o código. Pronto!' },
    ],
  };

  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-card">
      <h3 className="font-display text-[14px] font-semibold text-ink">Como conectar</h3>

      {/* Caminho feliz EM DESTAQUE: a notificação chega neste mesmo celular. */}
      <div className="mt-3 rounded-card-sm border border-brand/40 bg-brand-soft p-4">
        <p className="font-display text-[13.5px] font-semibold text-ink">
          O jeito mais fácil: a notificação
        </p>
        <p className="mt-1 text-[13.5px] leading-snug text-ink-soft">
          O WhatsApp vai avisar <b className="text-ink">neste celular</b> que alguém quer conectar
          um aparelho.
        </p>
        <StepList passos={passosNotificacao} destaque />
      </div>

      {/* Fallback manual: menus diferentes por plataforma. */}
      <div className="mt-4">
        <p className="font-display text-[13.5px] font-semibold text-ink">
          A notificação não apareceu?
        </p>
        <p className="mt-1 text-[13.5px] leading-snug text-ink-soft">
          Tudo bem — dá pra fazer pelo menu do WhatsApp. Qual é o seu celular?
        </p>
        <PlataformaSwitch value={plataforma} onChange={setPlataforma} />
        <StepList passos={passosManual[plataforma]} />
      </div>

      <p className="mt-4 rounded-card-sm border border-line bg-bg px-3 py-2.5 text-[13px] leading-snug text-ink-soft">
        Depois de colar o código, volte pra esta tela — ela avisa quando o assistente conectar.
      </p>
    </section>
  );
}

/** Lista numerada de passos. `destaque` muda o badge pra brand cheio (caixa soft). */
function StepList({ passos, destaque = false }: { passos: Passo[]; destaque?: boolean }) {
  return (
    <ol className="mt-3 space-y-2.5">
      {passos.map((p, i) => (
        <li key={p.key} className="flex items-start gap-3">
          <span
            aria-hidden
            className={cn(
              'mt-px flex size-6 shrink-0 items-center justify-center rounded-full font-display text-[12px] font-bold',
              destaque ? 'bg-brand text-bg' : 'bg-brand-soft text-brand',
            )}
          >
            {i + 1}
          </span>
          <span className="text-[13.5px] leading-snug text-ink-soft">
            <span className="sr-only">Passo {i + 1}: </span>
            {p.texto}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Toggle Android/iPhone (aria-pressed; sem lib nova). Default Android. */
function PlataformaSwitch({
  value,
  onChange,
}: {
  value: Plataforma;
  onChange: (p: Plataforma) => void;
}) {
  const opcoes: { id: Plataforma; label: string }[] = [
    { id: 'android', label: 'Android' },
    { id: 'iphone', label: 'iPhone' },
  ];
  return (
    <div role="group" aria-label="Qual é o seu celular?" className="mt-3 grid grid-cols-2 gap-2">
      {opcoes.map((op) => (
        <button
          key={op.id}
          type="button"
          aria-pressed={value === op.id}
          onClick={() => onChange(op.id)}
          className={cn(
            'h-11 rounded-btn font-display text-[14px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            value === op.id
              ? 'bg-brand text-bg'
              : 'border border-line-strong bg-surface text-ink-soft hover:bg-surface-hover',
          )}
        >
          {op.label}
        </button>
      ))}
    </div>
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

/**
 * Mensagem do erro do POST /bot/resume. 409 { error:'suspensao_startap', message }
 * = a Startap pausou (billing/manual_other/abuse): mostra a `message` do backend
 * (com fallback fixo) sem expor o motivo cru. Outros erros caem no generico.
 */
function mensagemResume(err: unknown): string {
  if (err instanceof ApiError && err.status === 409 && isErr(err, 'suspensao_startap')) {
    if (typeof err.body === 'object' && err.body !== null) {
      const msg = (err.body as { message?: unknown }).message;
      if (typeof msg === 'string' && msg.trim()) return msg;
    }
    return MSG_SUSPENSAO_STARTAP;
  }
  return mensagemErro(err);
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
