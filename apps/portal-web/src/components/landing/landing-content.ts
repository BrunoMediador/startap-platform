export type LandingScenarioId = 'agenda' | 'audio' | 'human';

export type LandingMessage = Readonly<{
  role: 'assistant' | 'customer';
  text: string;
  emphasis?: boolean;
}>;

export type LandingScenario = Readonly<{
  id: LandingScenarioId;
  label: string;
  messages: readonly LandingMessage[];
  status: string;
  day: string;
  eventTitle: string;
  eventDetail: string;
  controlTitle: string;
  controlDetail: string;
  assistantPaused: boolean;
}>;

export const LANDING_CTAS = {
  primary: { label: 'Testar 7 dias no meu WhatsApp', href: '/cadastro' },
  login: { label: 'Entrar', href: '/login' },
  final: { label: 'Começar meu teste', href: '/cadastro' },
} as const;

export const LANDING_SCENARIOS: readonly LandingScenario[] = [
  {
    id: 'agenda',
    label: 'Agendamento',
    messages: [
      { role: 'assistant', text: 'Oi! Como posso te ajudar hoje?' },
      { role: 'customer', text: 'Tem corte amanhã depois das 15h?' },
      { role: 'assistant', text: 'Tenho às 15:30 ou 17:00. Qual fica melhor?' },
      { role: 'customer', text: '15:30 👍' },
      {
        role: 'assistant',
        text: '✓ Pronto! Corte confirmado amanhã às 15:30.',
        emphasis: true,
      },
    ],
    status: 'Agenda sincronizada',
    day: 'Amanhã',
    eventTitle: '15:30 · Corte',
    eventDetail: 'Cliente confirmado',
    controlTitle: 'Assistente ativo',
    controlDetail: 'Você pode assumir a conversa',
    assistantPaused: false,
  },
  {
    id: 'audio',
    label: 'Entende áudio',
    messages: [
      { role: 'assistant', text: 'Oi! Como posso te ajudar hoje?' },
      { role: 'customer', text: '🎙️ Áudio · 0:08' },
      { role: 'assistant', text: 'Entendi: você quer fazer a barba sexta à tarde.' },
      {
        role: 'assistant',
        text: 'Tenho 14:30 ou 16:00. Qual você prefere?',
        emphasis: true,
      },
    ],
    status: 'Áudio compreendido',
    day: 'Intenção detectada',
    eventTitle: 'Serviço · Barba',
    eventDetail: 'Sexta à tarde',
    controlTitle: 'Assistente ouvindo',
    controlDetail: 'Áudio vira contexto da conversa',
    assistantPaused: false,
  },
  {
    id: 'human',
    label: 'Assumir conversa',
    messages: [
      { role: 'assistant', text: 'Oi! Como posso te ajudar hoje?' },
      { role: 'customer', text: 'Quero falar com alguém sobre meu pacote.' },
      { role: 'assistant', text: 'Claro — vou chamar a equipe para continuar daqui.' },
      {
        role: 'assistant',
        text: '✓ Conversa transferida sem perder o histórico.',
        emphasis: true,
      },
    ],
    status: 'Transferência inteligente',
    day: 'Atendimento humano',
    eventTitle: 'Equipe avisada',
    eventDetail: 'Contexto preservado',
    controlTitle: 'Você assumiu',
    controlDetail: 'O assistente ficou em silêncio',
    assistantPaused: true,
  },
] as const;

export function isLandingScenarioId(value: string): value is LandingScenarioId {
  return LANDING_SCENARIOS.some((scenario) => scenario.id === value);
}

export function getLandingScenario(id: LandingScenarioId): LandingScenario {
  return LANDING_SCENARIOS.find((scenario) => scenario.id === id) ?? LANDING_SCENARIOS[0];
}
