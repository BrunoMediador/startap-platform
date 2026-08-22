/**
 * Conteúdo legal do portal (Termos de Uso + Política de Privacidade) — SCRUM-1.
 *
 * Texto v1 PUBLICADO (minuta do time de Legal/Compliance — Bruno Silva Corrêa,
 * pessoa física). Para TROCAR o texto: edite apenas os blocos de dados abaixo
 * (`intro`/`sections`) — as rotas (/termos, /privacidade) e o render (LegalDoc) não
 * mudam. Modelo de blocos tipados (parágrafo, subtítulo, lista, tabela, destaque) —
 * sem dependência de markdown.
 *
 * REGRAS DE CONTEÚDO (não violar):
 *  - O CPF do responsável fica SEMPRE MASCARADO aqui (136.***.***-70). O CPF completo
 *    só existe no comprovante de aceite armazenado (terms_acceptances), nunca nesta
 *    página pública.
 *  - Sem notas internas, sem marcadores {{ }} / [PREENCHER] / [PLACEHOLDER].
 *
 * VERSIONAMENTO: ao mudar QUALQUER texto, bumpar a versão (v1 -> v2) E manter em
 * sincronia com o backend (apps/portal-api/src/lib/legal-version.ts:
 * TERMS_VERSION / PRIVACY_VERSION) — é a versão gravada como prova de aceite.
 */

/** Bloco de conteúdo legal renderizável (ver components/legal/legal-doc.tsx). */
export type LegalBlock =
  | { kind: 'p'; text: string }
  | { kind: 'sub'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'callout'; text: string };

export interface LegalDocument {
  slug: 'termos' | 'privacidade';
  title: string;
  /** Versão exibida e que DEVE bater com a gravada no aceite (server-authoritative). */
  version: string;
  /** Data de vigência / última atualização. */
  updatedAt: string;
  intro: LegalBlock[];
  sections: { heading: string; blocks: LegalBlock[] }[];
}

// Versões — MANTER EM SINCRONIA com apps/portal-api/src/lib/legal-version.ts.
export const TERMS_VERSION = 'v1';
// v3 (21/08/2026): inclui foto de perfil do WhatsApp no CRM, sua finalidade e
// retenção máxima do cache técnico. Bump preserva prova do texto novo.
export const PRIVACY_VERSION = 'v3';

// Data de vigência v1 (decisão Bruno/PM).
const VIGENCIA = '26/06/2026';

// Última atualização da Política de Privacidade. Só a Política mudou; os Termos seguem
// em VIGENCIA.
const PRIVACIDADE_ATUALIZADA = '21/08/2026';

// CPF SEMPRE mascarado nesta página pública (o completo vive só no aceite gravado).
const CPF_MASCARADO = '136.***.***-70';

const p = (text: string): LegalBlock => ({ kind: 'p', text });
const sub = (text: string): LegalBlock => ({ kind: 'sub', text });
const ul = (items: string[]): LegalBlock => ({ kind: 'ul', items });
const callout = (text: string): LegalBlock => ({ kind: 'callout', text });
const table = (columns: string[], rows: string[][]): LegalBlock => ({
  kind: 'table',
  columns,
  rows,
});

export const TERMOS_DE_USO: LegalDocument = {
  slug: 'termos',
  title: 'Termos de Uso e Condições do Serviço',
  version: TERMS_VERSION,
  updatedAt: VIGENCIA,
  intro: [],
  sections: [
    {
      heading: '1. Aceite e ciência',
      blocks: [
        p(
          `Estes Termos de Uso ("Termos") regem o acesso e o uso da plataforma Startap, oferecida por Bruno Silva Corrêa, pessoa natural, inscrita no CPF sob nº ${CPF_MASCARADO}, com domicílio em Itajubá/MG ("Startap", "nós"). A Startap é operada por pessoa física; não há pessoa jurídica/CNPJ associado a este serviço.`,
        ),
        p(
          'Ao criar uma conta, marcar a caixa de aceite no cadastro ou utilizar a plataforma, o Cliente (a pessoa física ou jurídica titular da conta, doravante "você" ou "Estabelecimento") declara que leu — ou teve a oportunidade de ler — estes Termos e a Política de Privacidade, que os entendeu, e que está ciente e de acordo com todo o seu conteúdo. Esse aceite vale como manifestação válida de vontade e prova de concordância.',
        ),
        p('A Política de Privacidade é parte integrante destes Termos.'),
        p('Se você aceita em nome de uma empresa, declara ter poderes para vinculá-la.'),
        callout(
          'O que você está aceitando, em resumo (a leitura integral é recomendada): assinatura mensal recorrente, que você pode cancelar quando quiser, sem devolução do valor do período já pago (seções 5 e 11); dependência de serviços de terceiros pelos quais não respondemos — como WhatsApp e provedores de IA (seção 8); e possibilidade de reajuste da mensalidade conforme o custo das APIs de terceiros, para mais ou para menos (seção 5.8).',
        ),
      ],
    },
    {
      heading: '2. Definições',
      blocks: [
        ul([
          'Plataforma / Serviço: o software da Startap, incluindo o assistente de atendimento via WhatsApp e o portal de gestão (app.startap.tech).',
          'Assistente / Bot: o agente automatizado que atende, via WhatsApp, os clientes do Estabelecimento.',
          'Cliente Final: a pessoa que conversa com o Assistente do Estabelecimento.',
          'Conteúdo do Cliente: dados, mensagens, agendamentos e configurações inseridos por você ou gerados no uso do Serviço.',
        ]),
      ],
    },
    {
      heading: '3. Objeto',
      blocks: [
        p(
          'A Startap concede a você uma licença de uso, não exclusiva, intransferível e revogável, durante a vigência do contrato, para utilizar a Plataforma como serviço (SaaS) para: (i) operar um assistente de atendimento automatizado via WhatsApp para seus Clientes Finais; e (ii) gerir agendamentos, faturamento do estabelecimento, perfil e demais funcionalidades disponíveis no portal.',
        ),
        p(
          'O Serviço é prestado "no estado em que se encontra" e pode evoluir, com inclusão, alteração ou remoção de funcionalidades.',
        ),
      ],
    },
    {
      heading: '4. Cadastro e conta',
      blocks: [
        p(
          '4.1. Para usar o Serviço, você deve fornecer informações verdadeiras, completas e atualizadas e mantê-las assim.',
        ),
        p(
          '4.2. As credenciais de acesso são pessoais e intransferíveis. Você é responsável por toda atividade realizada em sua conta e deve comunicar imediatamente qualquer uso não autorizado.',
        ),
        p(
          '4.3. A Startap pode recusar, suspender ou encerrar cadastros que violem estes Termos, a legislação ou as políticas de terceiros (ex.: WhatsApp/Meta).',
        ),
        p('4.4. O Serviço destina-se a maiores de 18 anos, no uso profissional/empresarial.'),
      ],
    },
    {
      heading: '5. Assinatura, pagamento e reajuste',
      blocks: [
        p(
          '5.1. Assinatura recorrente (modelo de streaming): o Serviço é contratado como uma assinatura mensal recorrente, à semelhança de serviços de streaming. Enquanto a assinatura estiver ativa, a cobrança se repete automaticamente a cada ciclo (mês), até que você cancele.',
        ),
        p(
          '5.2. Cancelamento a qualquer momento: você pode cancelar a assinatura quando quiser, pelos canais disponíveis. O cancelamento interrompe as cobranças dos próximos ciclos.',
        ),
        p(
          '5.3. Sem reembolso do período já pago: o cancelamento não gera reembolso, devolução ou restituição dos valores já pagos referentes ao ciclo/período vigente. Você continua com acesso ao Serviço até o fim do período já pago e, a partir daí, o acesso é encerrado. Não há cobrança proporcional nem estorno de dias não utilizados do ciclo corrente.',
        ),
        p(
          '5.4. Período de teste (trial): poderá ser oferecido um período de teste gratuito, quando disponibilizado e conforme definido no momento da contratação. Ao fim do período de teste, o acesso continuado depende da contratação paga.',
        ),
        p(
          '5.5. Valor da mensalidade (personalizado): não há tabela de preço fixa. O valor da mensalidade é o acordado individualmente com cada cliente no momento da contratação, conforme o escopo do atendimento, e fica registrado no portal/proposta. Esse será o valor base da assinatura recorrente.',
        ),
        p(
          '5.6. Forma de pagamento: a cobrança é realizada via PIX, processada pelo parceiro AbacatePay. Ao contratar, você autoriza a geração das cobranças recorrentes e o tratamento dos dados de pagamento necessários, conforme a Política de Privacidade.',
        ),
        p(
          '5.7. Vencimento e inadimplência: o pagamento deve ser feito até a data de vencimento informada. Em caso de não pagamento, a Startap pode, após 5 dias, suspender o acesso ao Serviço e, persistindo a inadimplência, encerrar a conta, sem prejuízo da cobrança dos valores devidos.',
        ),
        p(
          '5.8. Reajuste conforme custo de terceiros: o Serviço depende de APIs de terceiros (como provedores de inteligência artificial — ex.: OpenAI — e demais integrações) cujo custo varia ao longo do tempo. Por isso, a mensalidade pode ser reajustada — para mais ou para menos — acompanhando a variação do custo dessas APIs e demais custos do Serviço. Qualquer reajuste será comunicado com aviso prévio de 30 dias e passará a valer a partir do ciclo seguinte. Ao aceitar estes Termos, você declara estar ciente e de acordo com essa possibilidade de reajuste. Se não concordar com um reajuste, você pode cancelar a assinatura antes de ele entrar em vigor (seções 5.2 e 5.3).',
        ),
        p(
          '5.9. Tributos: os valores não incluem tributos eventualmente devidos, que serão suportados conforme a legislação.',
        ),
      ],
    },
    {
      heading: '6. Obrigações e responsabilidades do Cliente',
      blocks: [
        p('Você se compromete a usar o Serviço de forma lícita e, em especial:'),
        p(
          '6.1. Uso lícito do WhatsApp: cumprir integralmente os Termos do WhatsApp, a Política de Uso da WhatsApp Business e as políticas da Meta, incluindo a vedação a spam, mensagens em massa não solicitadas, fraude, phishing, conteúdo ilícito, enganoso, ofensivo ou que viole direitos de terceiros. O número de WhatsApp e a conta utilizada são de sua responsabilidade.',
        ),
        p(
          '6.2. Base legal e consentimento dos Clientes Finais: você é o Controlador dos dados dos seus Clientes Finais (conforme a Política de Privacidade) e é o responsável por garantir base legal válida (ex.: consentimento ou execução de procedimentos a pedido do titular) e por informar adequadamente seus Clientes Finais sobre o atendimento automatizado e o tratamento de seus dados. Você declara possuir autorização para que esses dados sejam tratados pela Startap como sua Operadora.',
        ),
        p(
          '6.3. Conteúdo: você é responsável pelo Conteúdo do Cliente, pelas configurações do Assistente (incluindo instruções, preços e serviços) e pelas respostas geradas a partir delas.',
        ),
        p(
          '6.4. Não fazer: (a) usar o Serviço para fins ilícitos; (b) tentar burlar limites técnicos, acessar dados de outros estabelecimentos, fazer engenharia reversa, copiar ou revender o Serviço; (c) sobrecarregar ou comprometer a infraestrutura; (d) utilizar o Assistente para coletar dados sensíveis ou de menores sem base legal adequada.',
        ),
        p(
          '6.5. Você indenizará a Startap por perdas decorrentes de violação destas obrigações, incluindo reclamações de terceiros, de Clientes Finais, da Meta ou de autoridades.',
        ),
      ],
    },
    {
      heading: '7. Proteção de dados (LGPD) e papel das partes',
      blocks: [
        p(
          '7.1. O tratamento de dados pessoais é regido pela Política de Privacidade da Startap, que integra estes Termos.',
        ),
        p(
          '7.2. Quanto aos dados dos Clientes Finais, as partes reconhecem que o Estabelecimento é o Controlador e a Startap é a Operadora, tratando tais dados em nome e sob instruções do Estabelecimento, exclusivamente para a prestação do Serviço.',
        ),
        p(
          '7.3. Quanto aos dados de cadastro, conta e pagamento do Estabelecimento, a Startap é a Controladora.',
        ),
        p(
          '7.4. As partes se obrigam a cumprir a LGPD. A Startap manterá medidas de segurança compatíveis e auxiliará o Estabelecimento, na medida do razoável, no atendimento a direitos de titulares e a obrigações legais aplicáveis à condição de Operadora (art. 39 da LGPD).',
        ),
      ],
    },
    {
      heading: '8. Serviços de terceiros, disponibilidade e isenção de responsabilidade',
      blocks: [
        p(
          '8.1. Empregamos esforços razoáveis para manter o Serviço disponível, mas não garantimos funcionamento ininterrupto ou livre de erros. Pode haver manutenções, atualizações e indisponibilidades.',
        ),
        p(
          '8.2. O Serviço depende de serviços de TERCEIROS, sobre os quais a Startap não tem controle e pelos quais não se responsabiliza, em especial:',
        ),
        ul([
          'WhatsApp / WAHA / Meta: a conexão é feita por meio do WhatsApp (via WAHA). A Startap não responde por instabilidade, lentidão, queda, indisponibilidade, bloqueio, suspensão ou banimento do número/conta de WhatsApp pela Meta, nem por mudanças nas regras ou na API do WhatsApp/Meta. A manutenção e o uso adequado do número de WhatsApp são de sua responsabilidade.',
          'Provedores de Inteligência Artificial (ex.: OpenAI) e demais APIs: a geração de respostas e a transcrição de áudios dependem de provedores de IA de terceiros. A Startap não responde por indisponibilidade, falha, lentidão, alteração de funcionalidades ou mudança de preço desses provedores. Reajustes de preço de terceiros podem refletir na mensalidade, nos termos da seção 5.8.',
        ]),
        p(
          '8.3. Indisponibilidades, mudanças de políticas, suspensões de conta ou falhas dos terceiros indicados acima não configuram inadimplemento da Startap e não dão direito a reembolso, abatimento ou indenização.',
        ),
      ],
    },
    {
      heading: '9. Propriedade intelectual',
      blocks: [
        p(
          '9.1. A Plataforma, o código-fonte, a marca, o design, a documentação e todas as melhorias são e permanecem de titularidade exclusiva da Startap. Estes Termos não transferem qualquer direito de propriedade intelectual a você, concedendo apenas a licença de uso descrita na seção 3.',
        ),
        p(
          '9.2. O Conteúdo do Cliente permanece de titularidade do Cliente. Você concede à Startap uma licença limitada para hospedar, processar e transmitir esse conteúdo na medida necessária à prestação do Serviço (incluindo o uso dos subprocessadores indicados na Política de Privacidade).',
        ),
        p(
          '9.3. A Startap pode usar dados agregados e anonimizados (que não identifiquem você nem seus Clientes Finais) para operar, melhorar e divulgar o Serviço.',
        ),
      ],
    },
    {
      heading: '10. Limitação de responsabilidade',
      blocks: [
        p(
          '10.1. Na máxima extensão permitida pela lei, a Startap não responde por danos indiretos, lucros cessantes, perda de dados, perda de oportunidade ou danos decorrentes de fatos de terceiros (ex.: Meta, provedores de IA, falha de internet).',
        ),
        p(
          '10.2. A responsabilidade total da Startap, por qualquer causa relacionada ao Serviço, fica limitada ao valor efetivamente pago por você nos 12 (doze) meses anteriores ao fato gerador.',
        ),
        p(
          '10.3. As limitações desta seção não se aplicam a hipóteses em que a limitação seja vedada por lei (ex.: dolo).',
        ),
      ],
    },
    {
      heading: '11. Suspensão e cancelamento',
      blocks: [
        p(
          '11.1. Cancelamento por você: você pode cancelar a assinatura a qualquer momento, pelos canais disponíveis. O cancelamento encerra as cobranças futuras; você mantém o acesso até o fim do período já pago. Não há reembolso, devolução ou restituição dos valores já pagos do ciclo/período vigente (seção 5.3).',
        ),
        p(
          '11.2. Suspensão/encerramento pela Startap: podemos suspender ou encerrar o acesso, no todo ou em parte, em caso de (a) inadimplência (seção 5); (b) violação destes Termos, da AUP ou das políticas da Meta; (c) risco à segurança, à plataforma ou a terceiros; (d) determinação legal/judicial.',
        ),
        p(
          '11.3. Efeitos do encerramento: cessada a relação, o acesso é desativado. Os dados serão tratados conforme a Política de Privacidade (retenção e eliminação). Mediante solicitação e dentro do prazo aplicável, podemos disponibilizar exportação do Conteúdo do Cliente antes da eliminação.',
        ),
      ],
    },
    {
      heading: '12. Alterações dos Termos',
      blocks: [
        p(
          'Podemos alterar estes Termos a qualquer tempo. Mudanças relevantes serão comunicadas pelo portal e/ou e-mail, com antecedência razoável. O uso continuado após a vigência implica concordância. Caso não concorde, você pode encerrar a conta.',
        ),
      ],
    },
    {
      heading: '13. Comunicações',
      blocks: [
        p(
          'As comunicações serão feitas pelo e-mail cadastrado, pelo portal app.startap.tech e/ou pelo WhatsApp da conta. Nosso canal de contato é startapsuporte@gmail.com. É sua responsabilidade manter seus dados de contato atualizados.',
        ),
      ],
    },
    {
      heading: '14. Disposições gerais',
      blocks: [
        p(
          '14.1. A eventual tolerância quanto a qualquer descumprimento não constitui novação nem renúncia.',
        ),
        p('14.2. A nulidade de uma cláusula não afeta as demais.'),
        p(
          '14.3. Você não pode ceder estes Termos sem anuência da Startap; a Startap pode cedê-los em caso de reorganização, mediante aviso.',
        ),
        p(
          '14.4. Estes Termos, a Política de Privacidade e eventual proposta comercial/DPA constituem o acordo integral entre as partes.',
        ),
      ],
    },
    {
      heading: '15. Lei aplicável e foro',
      blocks: [
        p(
          'Estes Termos são regidos pela legislação brasileira. Fica eleito o foro da Comarca de Itajubá/MG para dirimir controvérsias, com renúncia a qualquer outro, ressalvada eventual competência legal diversa.',
        ),
      ],
    },
  ],
};

export const POLITICA_PRIVACIDADE: LegalDocument = {
  slug: 'privacidade',
  title: 'Política de Privacidade',
  version: PRIVACY_VERSION,
  updatedAt: PRIVACIDADE_ATUALIZADA,
  intro: [],
  sections: [
    {
      heading: '1. Quem somos e a quem esta Política se aplica',
      blocks: [
        p(
          `Esta Política de Privacidade descreve como Bruno Silva Corrêa, pessoa natural, inscrita no CPF sob nº ${CPF_MASCARADO}, com domicílio em Itajubá/MG ("Startap", "nós"), trata dados pessoais no âmbito da plataforma Startap — um software como serviço (SaaS) que oferece, a estabelecimentos comerciais (como barbearias, salões e prestadores de serviço), um assistente de atendimento via WhatsApp e um portal de gestão (app.startap.tech). A Startap é operada por pessoa física (não há pessoa jurídica/CNPJ associado).`,
        ),
        p(
          'Esta Política observa a Lei nº 13.709/2018 (Lei Geral de Proteção de Dados Pessoais – LGPD) e demais normas aplicáveis.',
        ),
        p('Esta Política se aplica a duas categorias de titulares:'),
        ul([
          '(a) Clientes contratantes ("Donos" / "Estabelecimentos"): a pessoa física ou o representante do estabelecimento que contrata e paga pela plataforma.',
          '(b) Clientes finais do Estabelecimento ("Clientes Finais"): as pessoas que conversam com o assistente de WhatsApp do Estabelecimento (por exemplo, para agendar um horário).',
        ]),
        p(
          'A leitura da seção 3 ("Nossos papéis sob a LGPD") é essencial, pois tratamos esses dois grupos de dados em papéis diferentes.',
        ),
        p(
          'Ciência e aceite: ao criar uma conta, marcar a caixa de aceite no cadastro ou utilizar a plataforma, o Cliente declara que leu — ou teve a oportunidade de ler — esta Política de Privacidade e os Termos de Uso, que os entendeu, e que está ciente e de acordo com o tratamento de dados aqui descrito. Esta Política é parte integrante dos Termos de Uso.',
        ),
      ],
    },
    {
      heading: '2. Definições (LGPD)',
      blocks: [
        ul([
          'Dado pessoal: informação relacionada a pessoa natural identificada ou identificável.',
          'Titular: a pessoa natural a quem se referem os dados pessoais.',
          'Tratamento: toda operação com dados pessoais (coleta, uso, armazenamento, compartilhamento, eliminação etc.).',
          'Controlador: quem decide sobre o tratamento dos dados pessoais (as finalidades e os meios).',
          'Operador: quem trata dados pessoais em nome do Controlador, seguindo suas instruções.',
          'Encarregado (DPO): pessoa indicada para atuar como canal de comunicação entre o Controlador, os titulares e a ANPD.',
          'ANPD: Autoridade Nacional de Proteção de Dados.',
          'Subprocessador: terceiro contratado para apoiar o tratamento de dados (ex.: provedores de nuvem e de IA).',
        ]),
      ],
    },
    {
      heading: '3. Nossos papéis sob a LGPD (leia com atenção)',
      blocks: [
        p('A Startap atua em dois papéis distintos, conforme o tipo de dado:'),
        sub('3.1 Startap como CONTROLADORA — dados do Dono/Estabelecimento'),
        p(
          'Em relação aos dados de cadastro, conta e pagamento do Dono (quem contrata a plataforma), a Startap é a Controladora: nós definimos as finalidades e os meios desse tratamento (faturamento, suporte, gestão da conta, segurança). Esta Política rege esse tratamento de forma direta.',
        ),
        sub('3.2 Startap como OPERADORA — dados dos Clientes Finais do Estabelecimento'),
        p(
          'Em relação aos dados dos Clientes Finais (as pessoas que conversam com o assistente de WhatsApp do Estabelecimento — nome, telefone, mensagens, áudios e agendamentos), o Estabelecimento contratante é a CONTROLADORA desses dados, e a Startap atua como OPERADORA, tratando-os em nome e sob as instruções do Estabelecimento, exclusivamente para prestar o serviço contratado.',
        ),
        p('Isso significa que:'),
        ul([
          'A relação com o Cliente Final (incluindo a obtenção de consentimento ou outra base legal para o atendimento via WhatsApp) é, em primeiro plano, responsabilidade do Estabelecimento Controlador.',
          'Pedidos de exercício de direitos de Clientes Finais devem, em regra, ser direcionados ao Estabelecimento com quem ele se relaciona. A Startap apoiará o Estabelecimento no atendimento desses pedidos, na qualidade de Operadora (ver seção 9).',
          'A Startap não usa os dados dos Clientes Finais para finalidades próprias e independentes das instruções do Estabelecimento, ressalvado o tratamento técnico mínimo necessário ao funcionamento, segurança e melhoria do serviço, e o cumprimento de obrigações legais.',
        ]),
      ],
    },
    {
      heading: '4. Dados que coletamos',
      blocks: [
        sub('4.1 Dados do Dono/Estabelecimento (Startap como Controladora)'),
        table(
          ['Categoria', 'Exemplos', 'Origem'],
          [
            [
              'Dados de cadastro',
              'nome, e-mail, telefone, nome do estabelecimento, endereço comercial, redes sociais (ex.: Instagram), formas de pagamento aceitas pelo estabelecimento',
              'fornecidos no signup/portal',
            ],
            [
              'Dados de conta',
              'login, configurações do bot e da agenda, perfil "Meu negócio"',
              'gerados no uso do portal',
            ],
            [
              'Dados de pagamento',
              'informações necessárias à cobrança da mensalidade via PIX, processadas pelo AbacatePay (ver seção 6); histórico de cobranças e status (em dia / em atraso)',
              'fornecidos/gerados no fluxo de pagamento',
            ],
            [
              'Dados de uso e técnicos',
              'logs de acesso, identificadores de sessão, registros de eventos, dados de diagnóstico',
              'gerados automaticamente',
            ],
          ],
        ),
        sub('4.2 Dados dos Clientes Finais (Startap como Operadora, em nome do Estabelecimento)'),
        table(
          ['Categoria', 'Exemplos', 'Origem'],
          [
            [
              'Identificação e contato',
              'nome e número de telefone (WhatsApp)',
              'conversa com o assistente',
            ],
            [
              'Foto de perfil',
              'foto de perfil do WhatsApp, quando disponibilizada pela plataforma',
              'WhatsApp, no contexto da sessão do Estabelecimento',
            ],
            [
              'Conteúdo de comunicação',
              'mensagens de texto trocadas com o assistente; áudios e suas transcrições',
              'conversa com o assistente',
            ],
            [
              'Dados de agendamento',
              'data, horário, serviço, profissional, eventuais observações',
              'agendamentos feitos pelo assistente/portal',
            ],
          ],
        ),
        callout(
          'Não é nossa intenção coletar dados pessoais sensíveis (art. 11 da LGPD) dos Clientes Finais. Caso o Cliente Final insira espontaneamente esse tipo de informação na conversa, o tratamento ocorrerá sob responsabilidade do Estabelecimento Controlador, no limite necessário à prestação do serviço.',
        ),
      ],
    },
    {
      heading: '5. Finalidades e bases legais',
      blocks: [
        sub('5.1 Dados do Dono/Estabelecimento (Controladora: Startap)'),
        table(
          ['Finalidade', 'Base legal (LGPD)'],
          [
            [
              'Criar e manter a conta; prestar o serviço contratado',
              'Execução de contrato (art. 7º, V)',
            ],
            [
              'Cobrar a mensalidade recorrente e gerir o faturamento (PIX/AbacatePay)',
              'Execução de contrato (art. 7º, V) e cumprimento de obrigação legal/fiscal (art. 7º, II)',
            ],
            [
              'Prestar suporte e enviar comunicações operacionais (ex.: aviso de desconexão da sessão, vencimento)',
              'Execução de contrato (art. 7º, V)',
            ],
            [
              'Segurança da informação, prevenção a fraude e abuso',
              'Legítimo interesse (art. 7º, IX)',
            ],
            [
              'Análise estatística agregada e melhoria do produto (dados anonimizados sempre que possível)',
              'Legítimo interesse (art. 7º, IX)',
            ],
            [
              'Cumprir obrigações legais, regulatórias e ordens de autoridade',
              'Cumprimento de obrigação legal (art. 7º, II)',
            ],
            [
              'Comunicações de marketing/novidades (se aplicável)',
              'Consentimento (art. 7º, I) — com opção de descadastro',
            ],
          ],
        ),
        sub('5.2 Dados dos Clientes Finais (Operadora: Startap; Controladora: Estabelecimento)'),
        p('A Startap trata esses dados sob instrução do Estabelecimento, para as finalidades de:'),
        ul([
          'atender o Cliente Final via WhatsApp, esclarecer dúvidas, realizar/gerenciar agendamentos e, quando o Estabelecimento assim configurar, encaminhar à equipe do Estabelecimento um resumo do atendimento (nome, contato e preferências de horário/serviço/profissional) para que a recepção conclua o atendimento;',
          'exibir, no CRM do Estabelecimento, a foto de perfil do WhatsApp quando disponibilizada, para identificar o contato e apoiar o atendimento;',
          'transcrever áudios para permitir o atendimento;',
          'enviar comunicações transacionais relacionadas ao agendamento (ex.: confirmação; lembrete, quando ativado pelo Estabelecimento).',
        ]),
        p(
          'A base legal desse tratamento é definida pelo Estabelecimento Controlador — tipicamente execução de contrato/procedimentos preliminares a pedido do titular (art. 7º, V) e/ou consentimento do Cliente Final (art. 7º, I), conforme o caso. É obrigação do Estabelecimento garantir base legal válida e informar adequadamente seus Clientes Finais (ver Termos de Uso).',
        ),
      ],
    },
    {
      heading: '6. Compartilhamento e subprocessadores',
      blocks: [
        p(
          'Não vendemos dados pessoais. Compartilhamos dados apenas com prestadores que viabilizam o serviço ("subprocessadores"), com autoridades quando exigido por lei, e em eventual reorganização (com aviso).',
        ),
        p('Subprocessadores em uso:'),
        table(
          [
            'Subprocessador',
            'Finalidade',
            'Dados envolvidos',
            'Localização / transferência internacional',
          ],
          [
            [
              'WAHA / WhatsApp (Meta)',
              'conexão e troca de mensagens no WhatsApp',
              'número, mensagens, conteúdo da conversa',
              'sujeito à infraestrutura/políticas do WhatsApp/Meta',
            ],
            [
              'OpenAI',
              'geração de respostas do assistente e transcrição de áudios',
              'conteúdo de mensagens e áudios dos Clientes Finais',
              'EUA — transferência internacional',
            ],
            [
              'DeepSeek',
              'geração de respostas (assistente de prospecção/demo)',
              'conteúdo de mensagens',
              'fora do Brasil (servidores na China) — transferência internacional',
            ],
            [
              'Google (Google Calendar via Service Account)',
              'sincronização da agenda do Estabelecimento',
              'dados de agendamento (data/hora, serviço, profissional)',
              'EUA — transferência internacional',
            ],
            [
              'AbacatePay',
              'processamento de cobrança via PIX',
              'dados de pagamento e e-mail do Dono',
              'Brasil',
            ],
            [
              'Provedor de VPS / infraestrutura',
              'hospedagem da aplicação e banco de dados',
              'todos os dados acima, processados na infraestrutura',
              'a confirmar',
            ],
          ],
        ),
        callout(
          'Transferência internacional de dados: parte dos subprocessadores opera fora do Brasil (EUA e China). Essas transferências ocorrem com fundamento nos arts. 33 a 36 da LGPD (notadamente para execução de contrato e mediante salvaguardas contratuais com o subprocessador). Estamos formalizando os instrumentos de tratamento (DPA) com cada um.',
        ),
      ],
    },
    {
      heading: '7. Retenção e eliminação',
      blocks: [
        p(
          'Mantemos os dados pessoais apenas pelo tempo necessário às finalidades acima. Os prazos abaixo são padrões razoáveis e ajustáveis a critério da Startap e conforme a legislação:',
        ),
        ul([
          'Dados de cadastro e conta do Dono: durante a vigência do contrato e por um período razoável após o encerramento (sugerido: até 12 meses; ajustável), salvo prazo legal maior.',
          'Dados de pagamento/faturamento: pelo prazo exigido pela legislação fiscal/contábil (em regra 5 anos).',
          'Dados dos Clientes Finais (conversas, áudios, transcrições, agendamentos): mantidos enquanto necessários à prestação do serviço ao Estabelecimento e conforme instrução deste; eliminados ou anonimizados ao fim do tratamento, mediante solicitação do Controlador, ou após um período razoável de inatividade (ajustável), salvo guarda exigida por lei.',
          'Foto de perfil do WhatsApp: quando o recurso estiver habilitado, mantida apenas em cache técnico temporário, por no máximo 24 horas, sem URL pública ou persistência em banco; eliminada antes desse prazo quando o contato for excluído.',
        ]),
        p(
          'Findo o prazo, os dados são eliminados ou anonimizados, ressalvadas as hipóteses do art. 16 da LGPD (cumprimento de obrigação legal, estudo por órgão de pesquisa com anonimização, transferência a terceiro com observância da lei, ou uso exclusivo do controlador com anonimização).',
        ),
      ],
    },
    {
      heading: '8. Segurança da informação',
      blocks: [
        p(
          'Adotamos medidas técnicas e administrativas para proteger os dados, como: controle de acesso ao portal (autenticação, sessão segura, proteção contra abuso de login), criptografia de credenciais sensíveis (ex.: chaves de integração armazenadas cifradas), segregação lógica por estabelecimento, backups e registros de eventos.',
        ),
        p(
          'Nenhum sistema é 100% seguro. Em caso de incidente de segurança que possa acarretar risco ou dano relevante aos titulares, comunicaremos a ANPD e os titulares afetados, conforme o art. 48 da LGPD e as orientações da Autoridade.',
        ),
      ],
    },
    {
      heading: '9. Direitos do titular',
      blocks: [
        p('Nos termos do art. 18 da LGPD, o titular pode requerer, a qualquer tempo:'),
        ul([
          'confirmação da existência de tratamento;',
          'acesso aos dados;',
          'correção de dados incompletos, inexatos ou desatualizados;',
          'anonimização, bloqueio ou eliminação de dados desnecessários, excessivos ou tratados em desconformidade;',
          'portabilidade dos dados a outro fornecedor, mediante requisição expressa;',
          'eliminação dos dados tratados com consentimento, salvo hipóteses legais de conservação;',
          'informação sobre o compartilhamento de dados;',
          'informação sobre a possibilidade de não consentir e suas consequências;',
          'revogação do consentimento.',
        ]),
        p('Como exercer:'),
        ul([
          'Donos/Estabelecimentos: entrar em contato pelo canal do Encarregado (seção 11).',
          'Clientes Finais: por serem dados sob controle do Estabelecimento, os pedidos devem, em regra, ser dirigidos ao Estabelecimento com quem o titular se relaciona. Caso o pedido chegue à Startap, nós o encaminharemos ao Estabelecimento Controlador e o apoiaremos no atendimento, na condição de Operadora.',
        ]),
        p(
          'Responderemos às solicitações nos prazos da LGPD e da regulamentação da ANPD. Podemos solicitar informações para confirmar a identidade do requerente.',
        ),
      ],
    },
    {
      heading: '10. Cookies e tecnologias no portal',
      blocks: [
        p(
          'O portal app.startap.tech utiliza apenas cookies estritamente necessários ao funcionamento (por exemplo, autenticação e segurança de sessão). Não utilizamos cookies de analytics ou de marketing de terceiros.',
        ),
      ],
    },
    {
      heading: '11. Encarregado pelo Tratamento de Dados (DPO)',
      blocks: [
        ul([
          'Encarregado(a): Bruno Silva Corrêa (responsável pela Startap).',
          'E-mail de contato: startapsuporte@gmail.com.',
        ]),
        p(
          'Este é o canal para dúvidas sobre esta Política, exercício de direitos e comunicação com a ANPD.',
        ),
      ],
    },
    {
      heading: '12. Alterações desta Política',
      blocks: [
        p(
          'Podemos atualizar esta Política a qualquer tempo. Mudanças relevantes serão comunicadas pelos canais usuais (portal e/ou e-mail). A data de "Última atualização" no topo indica a versão vigente. O uso continuado da plataforma após a vigência da nova versão implica ciência das alterações.',
        ),
      ],
    },
    {
      heading: '13. Lei aplicável e foro',
      blocks: [
        p(
          'Esta Política é regida pela legislação brasileira. Fica eleito o foro da Comarca de Itajubá/MG, com renúncia a qualquer outro, salvo competência legal diversa em favor do consumidor/titular.',
        ),
      ],
    },
  ],
};

export const LEGAL_DOCS = {
  termos: TERMOS_DE_USO,
  privacidade: POLITICA_PRIVACIDADE,
} as const;
