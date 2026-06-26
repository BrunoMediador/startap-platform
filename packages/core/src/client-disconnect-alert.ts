/**
 * client-disconnect-alert.ts — COPY + render PURO do auto-aviso de DESCONEXÃO ao próprio cliente
 * (B2B). Sem I/O, sem env, sem banco. Fácil de editar/testar isoladamente.
 *
 * QUANDO DISPARA: o monitor de sessões (Missão 021) detecta a sessão WAHA de um clone que JÁ
 * conectou caindo (transição up->down). Além do alerta interno pro Bruno, com a flag
 * CLIENT_DISCONNECT_ALERT_ENABLED ligada e o opt-in por-clone (alert_owner_enabled) o sistema
 * manda ESTE WhatsApp pro DONO do clone (nosso cliente B2B), avisando que o robô parou e como
 * reconectar sozinho no portal.
 *
 * NÃO é mensagem pros clientes finais do barbeiro — é uma notificação TRANSACIONAL pro nosso
 * cliente sobre o serviço dele. Risco LGPD baixo; ainda assim o transporte mantém opt-in +
 * telefone mascarado no log (ver apps/worker/.../client-disconnect-notify.ts).
 *
 * ⚠️ COPY EDITÁVEL: o Bruno quer poder ajustar o texto ("bem bonitinho"). Edite a constante
 * DEFAULT_CLIENT_DISCONNECT_COPY abaixo. Asteriscos = negrito no WhatsApp; emojis e quebras de
 * linha são propositais. Var suportada: {NOME_NEGOCIO}.
 */

/** Link do portal onde o cliente reconecta (sem barra final; a copy escreve "app.startap.tech"). */
export const PORTAL_RECONNECT_URL = 'app.startap.tech';

/**
 * Fallback do nome do negócio quando o clone não tem personalizacao->>'nome_negocio'. A copy fica
 * natural: "o WhatsApp do atendimento automático do *seu atendimento* desconectou" — por isso o
 * fallback é "seu atendimento" (não "sua empresa").
 */
export const CLIENT_DISCONNECT_NEGOCIO_FALLBACK = 'seu atendimento';

/**
 * COPY DEFAULT do auto-aviso de desconexão (PT-BR). ⚠️ EDITÁVEL pelo Bruno. {NOME_NEGOCIO} é
 * substituído pelo nome do negócio do cliente (ou pelo fallback). Asteriscos = negrito WhatsApp.
 */
export const DEFAULT_CLIENT_DISCONNECT_COPY = `Olá! Aqui é da *Startap* 👋

Passando rápido pra avisar: o WhatsApp do atendimento automático da *{NOME_NEGOCIO}* desconectou agora há pouco, e o robô está pausado no momento. 😕

✅ *Reconectar leva 1 minutinho e você mesmo faz:*

1️⃣ Acesse *app.startap.tech* e faça login
2️⃣ Abra a tela de *Conectar WhatsApp*
3️⃣ Escaneie o *QR Code* com o celular do número do seu negócio

⚠️ *Dica pra não cair de novo:* mantenha esse número conectado *só no nosso sistema* — se ele abrir em outro celular ou no WhatsApp Web, a conexão é derrubada.

Qualquer dúvida, é só responder aqui que a gente te ajuda na hora. 💈✨`;

export interface ClientDisconnectRenderVars {
  /**
   * Nome do negócio (personalizacao->>'nome_negocio'). null/vazio -> usa o fallback
   * CLIENT_DISCONNECT_NEGOCIO_FALLBACK ("seu atendimento").
   */
  nomeNegocio?: string | null;
  /** Override de copy (futuro: por clone). Vazio/null -> usa a DEFAULT_CLIENT_DISCONNECT_COPY. */
  copy?: string | null;
}

/**
 * Renderiza o texto final do aviso de desconexão. Substitui {NOME_NEGOCIO} (todas as ocorrências)
 * pelo nome do negócio ou pelo fallback. PURA — base do teste de copy. Não toca telefone/PII.
 */
export function renderClientDisconnectMessage(vars: ClientDisconnectRenderVars): string {
  const tpl = vars.copy && vars.copy.trim().length > 0 ? vars.copy : DEFAULT_CLIENT_DISCONNECT_COPY;
  const negocio =
    vars.nomeNegocio && vars.nomeNegocio.trim().length > 0
      ? vars.nomeNegocio.trim()
      : CLIENT_DISCONNECT_NEGOCIO_FALLBACK;
  return tpl.replace(/\{NOME_NEGOCIO\}/g, negocio);
}
