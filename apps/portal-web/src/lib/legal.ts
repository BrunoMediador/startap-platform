/**
 * Conteúdo legal do portal (Termos de Uso + Política de Privacidade) — SCRUM-1.
 *
 * ⚠️⚠️ TEXTO PROVISÓRIO (PLACEHOLDER) ⚠️⚠️
 * ───────────────────────────────────────────────────────────────────────────────────
 * O texto abaixo é RASCUNHO e NÃO tem validade jurídica. O texto REAL vem do
 * `juridico-lgpd` e deve ser COLADO AQUI (substituindo `intro`/`sections` de cada
 * documento) ANTES do merge. Os marcadores entre {{ }} precisam ser preenchidos:
 *
 *   {{RAZAO_SOCIAL}}  — razão social da empresa
 *   {{CNPJ}}          — CNPJ
 *   {{ENDERECO}}      — endereço completo
 *   {{DPO_NOME}}      — nome do Encarregado (DPO)
 *   {{DPO_EMAIL}}     — e-mail de contato do Encarregado/privacidade
 *
 * É um MÓDULO DE DADOS de propósito: trocar o texto = editar as strings abaixo, SEM
 * tocar nas rotas (/termos, /privacidade) nem no componente de render (LegalDoc).
 *
 * VERSIONAMENTO: ao mudar QUALQUER texto, BUMPAR a versão (v1 -> v2 ...) E manter em
 * sincronia com o backend (apps/portal-api/src/routes/portal-signup.ts:
 * TERMS_VERSION / PRIVACY_VERSION) — é a versão gravada como prova de aceite.
 */

export interface LegalSection {
  heading: string;
  /** Parágrafos do bloco (cada item = um <p>). */
  body: string[];
}

export interface LegalDocument {
  slug: 'termos' | 'privacidade';
  title: string;
  /** Versão exibida e que DEVE bater com a gravada no aceite (server-authoritative). */
  version: string;
  /** Data da última atualização (preencher quando colar o texto real). */
  updatedAt: string;
  intro: string[];
  sections: LegalSection[];
}

// Versões — MANTER EM SINCRONIA com portal-signup.ts (TERMS_VERSION/PRIVACY_VERSION).
export const TERMS_VERSION = 'v1';
export const PRIVACY_VERSION = 'v1';

/** Banner repetido no topo dos dois docs enquanto o texto for placeholder. */
const PLACEHOLDER_AVISO =
  'Versão preliminar. O texto definitivo está em revisão jurídica e substituirá este conteúdo. Em caso de dúvida, fale com o suporte.';

export const TERMOS_DE_USO: LegalDocument = {
  slug: 'termos',
  title: 'Termos de Uso',
  version: TERMS_VERSION,
  updatedAt: 'PREENCHER (juridico-lgpd)',
  intro: [
    PLACEHOLDER_AVISO,
    // ↓↓↓ COLE AQUI o texto real dos Termos de Uso (juridico-lgpd). ↓↓↓
    'Estes Termos de Uso regulam o acesso e a utilização da plataforma de atendimento automatizado para WhatsApp operada por {{RAZAO_SOCIAL}}, inscrita no CNPJ {{CNPJ}}, com sede em {{ENDERECO}} ("Plataforma"). Ao criar uma conta e utilizar a Plataforma, você declara ter lido, compreendido e aceitado integralmente estes Termos.',
  ],
  sections: [
    {
      heading: '1. Objeto',
      body: [
        '[PLACEHOLDER] Descrição do serviço prestado pela Plataforma: provisão de um robô de atendimento via WhatsApp para agendamento e comunicação com clientes do contratante.',
      ],
    },
    {
      heading: '2. Cadastro e conta',
      body: [
        '[PLACEHOLDER] Condições de criação de conta, veracidade dos dados informados, responsabilidade pela guarda das credenciais e uso do número de WhatsApp.',
      ],
    },
    {
      heading: '3. Período de teste e planos',
      body: [
        '[PLACEHOLDER] Regras do teste grátis, início do período, planos pagos, valores, renovação e cobrança.',
      ],
    },
    {
      heading: '4. Obrigações do usuário',
      body: [
        '[PLACEHOLDER] Uso permitido, condutas vedadas, conformidade com as políticas do WhatsApp e com a legislação aplicável.',
      ],
    },
    {
      heading: '5. Suspensão e cancelamento',
      body: [
        '[PLACEHOLDER] Hipóteses de suspensão por inadimplência ou violação, cancelamento pelo usuário e efeitos.',
      ],
    },
    {
      heading: '6. Limitação de responsabilidade',
      body: ['[PLACEHOLDER] Limites de responsabilidade, disponibilidade do serviço e isenções.'],
    },
    {
      heading: '7. Disposições gerais e foro',
      body: [
        '[PLACEHOLDER] Alterações destes Termos, comunicação, legislação aplicável e foro de eleição.',
        'Dúvidas sobre estes Termos: {{DPO_EMAIL}}.',
      ],
    },
  ],
};

export const POLITICA_PRIVACIDADE: LegalDocument = {
  slug: 'privacidade',
  title: 'Política de Privacidade',
  version: PRIVACY_VERSION,
  updatedAt: 'PREENCHER (juridico-lgpd)',
  intro: [
    PLACEHOLDER_AVISO,
    // ↓↓↓ COLE AQUI o texto real da Política de Privacidade (juridico-lgpd). ↓↓↓
    'Esta Política de Privacidade descreve como {{RAZAO_SOCIAL}}, inscrita no CNPJ {{CNPJ}}, trata os dados pessoais coletados no uso da Plataforma, em conformidade com a Lei nº 13.709/2018 (LGPD).',
  ],
  sections: [
    {
      heading: '1. Dados que coletamos',
      body: [
        '[PLACEHOLDER] Categorias de dados coletados (ex.: nome do negócio, número de WhatsApp, IP e user-agent no aceite, dados de uso e de atendimento).',
      ],
    },
    {
      heading: '2. Finalidades e bases legais',
      body: [
        '[PLACEHOLDER] Para que usamos cada dado e a base legal correspondente (execução de contrato, consentimento, legítimo interesse, obrigação legal).',
      ],
    },
    {
      heading: '3. Compartilhamento',
      body: [
        '[PLACEHOLDER] Com quem os dados são compartilhados (operadores/sub-processadores: provedor de WhatsApp, provedores de IA, infraestrutura) e em quais condições.',
      ],
    },
    {
      heading: '4. Armazenamento e segurança',
      body: [
        '[PLACEHOLDER] Onde e por quanto tempo os dados são guardados e as medidas de segurança adotadas.',
      ],
    },
    {
      heading: '5. Direitos do titular',
      body: [
        '[PLACEHOLDER] Direitos garantidos pela LGPD (acesso, correção, eliminação, portabilidade, revogação do consentimento) e como exercê-los.',
      ],
    },
    {
      heading: '6. Encarregado (DPO) e contato',
      body: [
        '[PLACEHOLDER] Identificação do Encarregado pelo tratamento de dados.',
        'Encarregado (DPO): {{DPO_NOME}} — {{DPO_EMAIL}}.',
      ],
    },
  ],
};

export const LEGAL_DOCS = {
  termos: TERMOS_DE_USO,
  privacidade: POLITICA_PRIVACIDADE,
} as const;
