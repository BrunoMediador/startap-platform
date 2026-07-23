'use client';

import { IconSend } from '@/components/icons';
import {
  ChatBubble,
  ChatHeader,
  DemoBanner,
  PhoneFrame,
  TypingDots,
} from '@/components/landing/phone-frame';
import { type DemoChatMessage, sendDemoChat } from '@/lib/demo-chat';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
/**
 * Demo "celular" interativa da landing (W6). O visitante manda mensagem como se
 * fosse cliente; o robô (IA sandbox via POST /demo/chat) responde de verdade.
 *
 * Estados (todos da spec uiux): inicial (1 saudação fixa) · enviando (bolha
 * otimista + TypingDots, composer disabled) · resposta · tentou-marcar-horário
 * (demo_booking -> aviso inline + CTA) · rate-limit (CTA conversão) · erro
 * (tentar de novo) · indisponível/degrade (flag OFF / rota fora -> estado neutro,
 * sem quebrar a página).
 *
 * Sem PII: nada é logado; só o texto digitado trafega pro backend sandbox.
 */

// Salão fictício neutro (multi-vertical, sem foto/PII — guarda anti-cópia W6/W7).
const SALAO_NOME = 'Barbearia do Vale';
const SALAO_INICIAIS = 'BV';
const SAUDACAO = 'Oi! Aqui é a Barbearia do Vale 💈 Como posso te ajudar hoje?';
const HORA_FAKE = '9:41';

// Estado terminal da conversa: para de aceitar input e mostra o card de conversão.
type Encerramento = null | 'booking' | 'rate_limit';

interface Bolha {
  id: number;
  role: 'user' | 'assistant';
  texto: string;
}

export function DemoCelular() {
  const tituloId = useId();
  const inputId = useId();
  // Conversa visível (começa com a saudação fixa do salão).
  const [bolhas, setBolhas] = useState<Bolha[]>([{ id: 0, role: 'assistant', texto: SAUDACAO }]);
  const [rascunho, setRascunho] = useState('');
  const [pending, setPending] = useState(false);
  const [encerrada, setEncerrada] = useState<Encerramento>(null);
  // Erro transitório guarda a última msg do usuário pra reenviar no "tentar de novo".
  const [erro, setErro] = useState<{ texto: string } | null>(null);
  // Degrade: rota desligada/fora -> some o composer, mostra estado neutro.
  const [indisponivel, setIndisponivel] = useState(false);

  const nextId = useRef(1);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll suave pro fim sempre que entra bolha nova OU aparece/some o
  // "digitando". O efeito referencia bolhas.length e pending de propósito (ler o
  // ref nao e reativo, entao a dependencia precisa vir desses valores).
  const totalBolhas = bolhas.length;
  useEffect(() => {
    // bolhas/pending sao as dependencias reais do scroll; sao lidas aqui pra o
    // analisador reconhecer o uso (o scrollTo em si opera sobre o ref).
    void totalBolhas;
    void pending;
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [totalBolhas, pending]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function pushBolha(role: 'user' | 'assistant', texto: string) {
    const id = nextId.current++;
    setBolhas((prev) => [...prev, { id, role, texto }]);
  }

  async function enviar(texto: string) {
    const limpo = texto.trim();
    if (!limpo || pending || encerrada || indisponivel) return;

    setErro(null);
    setRascunho('');
    pushBolha('user', limpo);
    setPending(true);

    // Histórico pro backend: tudo que já está na tela + a msg nova (otimista).
    const historico: DemoChatMessage[] = [
      ...bolhas.map((b) => ({ role: b.role, content: b.texto })),
      { role: 'user', content: limpo },
    ];

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const out = await sendDemoChat(historico, ctrl.signal);
    setPending(false);

    if (out.kind === 'ok') {
      pushBolha('assistant', out.reply);
      if (out.demoBooking) setEncerrada('booking');
      return;
    }
    if (out.kind === 'rate_limit') {
      setEncerrada('rate_limit');
      return;
    }
    if (out.kind === 'unavailable') {
      setIndisponivel(true);
      return;
    }
    // erro transitório -> guarda pra reenviar
    setErro({ texto: limpo });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void enviar(rascunho);
  }

  return (
    <section aria-labelledby={tituloId} className="py-12 md:py-16">
      <div className="grid items-center gap-10 md:grid-cols-2 md:gap-12">
        {/* Coluna copy (esquerda no desktop, topo no mobile). */}
        <div className="text-center md:text-left">
          <h2
            id={tituloId}
            className="font-display text-[clamp(24px,3.4vw,34px)] font-bold tracking-[-0.02em] text-ink"
          >
            Veja o assistente atendendo ao vivo
          </h2>
          <p className="mx-auto mt-3 max-w-[42ch] text-[15px] leading-[1.6] text-ink-soft md:mx-0">
            Mande uma mensagem como se você fosse um cliente. Ele entende e responde na hora — igual
            ao que seus clientes vão receber.
          </p>
          <ul className="mx-auto mt-5 flex max-w-[42ch] flex-col gap-2 text-left text-[14px] text-ink-soft md:mx-0">
            {['Responde em segundos', 'Entende linguagem natural', 'Sem instalar nada'].map(
              (item) => (
                <li key={item} className="flex items-center gap-2.5">
                  <span
                    className="inline-block size-1.5 shrink-0 rounded-full bg-brand"
                    aria-hidden
                  />
                  {item}
                </li>
              ),
            )}
          </ul>
          <Link
            href="/cadastro"
            className="mt-7 inline-flex h-12 items-center justify-center rounded-btn bg-brand px-6 font-display text-[14.5px] font-semibold text-bg outline-none transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-[0.985] active:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            Quero isso no meu WhatsApp
          </Link>
        </div>

        {/* Coluna celular (direita no desktop, abaixo no mobile). */}
        <PhoneFrame>
          <ChatHeader nome={SALAO_NOME} iniciais={SALAO_INICIAIS} />

          {/* Região do chat: role=log + aria-live pra leitor anunciar respostas. */}
          <div
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="flex h-[300px] flex-col gap-2.5 overflow-y-auto bg-chat-bg px-3 py-4"
          >
            {bolhas.map((b) => (
              <ChatBubble
                key={b.id}
                variant={b.role === 'user' ? 'enviada' : 'recebida'}
                hora={HORA_FAKE}
              >
                {b.texto}
              </ChatBubble>
            ))}

            {pending && <TypingDots />}

            {encerrada === 'booking' && (
              <AvisoConversao
                titulo="Isto é uma demonstração"
                texto="Nada foi agendado de verdade aqui. No seu assistente, esse horário cairia direto na sua agenda."
              />
            )}
            {encerrada === 'rate_limit' && (
              <AvisoConversao
                titulo="Por hoje já deu pra sentir o assistente 😄"
                texto="Quer ele atendendo de verdade, com seus clientes? Crie sua conta grátis."
              />
            )}
            {erro && (
              <div className="flex flex-col items-center gap-2 py-2 text-center">
                <p className="text-[12.5px] text-ink-faint">Tive um soluço aqui. Tenta de novo?</p>
                <button
                  type="button"
                  onClick={() => void enviar(erro.texto)}
                  className="rounded-pill border border-line-strong bg-surface px-4 py-1.5 text-[12.5px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                >
                  Tentar de novo
                </button>
              </div>
            )}
            {indisponivel && (
              <p className="py-2 text-center text-[12.5px] text-ink-faint">
                A demo está indisponível no momento. Você pode{' '}
                <Link href="/cadastro" className="font-semibold text-brand hover:underline">
                  criar sua conta grátis
                </Link>{' '}
                e testar com seus clientes.
              </p>
            )}
          </div>

          {/* Composer: some quando a conversa encerra (booking/rate-limit) ou degrade. */}
          {encerrada === null && !indisponivel && (
            <form
              onSubmit={onSubmit}
              className="flex items-center gap-2 border-t border-line bg-surface px-3 py-2.5"
            >
              <label htmlFor={inputId} className="sr-only">
                Mensagem para a demonstração
              </label>
              <input
                id={inputId}
                value={rascunho}
                onChange={(e) => setRascunho(e.target.value)}
                disabled={pending}
                placeholder="Digite uma mensagem…"
                autoComplete="off"
                className="h-10 min-w-0 flex-1 rounded-pill border border-line bg-chat-bg px-4 text-[13.5px] text-ink placeholder:text-ink-faint outline-none transition-colors focus-visible:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={pending || rascunho.trim() === ''}
                aria-label="Enviar mensagem"
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand text-bg outline-none transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-95 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:bg-brand/35 disabled:text-ink-faint"
              >
                <IconSend size={18} />
              </button>
            </form>
          )}

          {/* CTA de conversão no rodapé quando encerrou (vira o ponto de saída). */}
          {encerrada !== null && (
            <div className="border-t border-line bg-surface px-3 py-3">
              <Link
                href="/cadastro"
                className="flex h-11 items-center justify-center rounded-btn bg-brand px-4 font-display text-[14px] font-semibold text-bg outline-none transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-[0.985] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Criar minha conta grátis
              </Link>
            </div>
          )}

          <DemoBanner />
        </PhoneFrame>
      </div>
    </section>
  );
}

/** Aviso inline dentro do chat (booking / rate-limit) — texto + CTA implícito acima. */
function AvisoConversao({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <div className="chat-bubble-in mx-1 rounded-card border border-brand/30 bg-brand-soft px-3.5 py-3 text-center">
      <p className="font-display text-[13px] font-semibold text-ink">{titulo}</p>
      <p className="mt-1 text-[12.5px] leading-snug text-ink-soft">{texto}</p>
    </div>
  );
}
