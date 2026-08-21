# Missao 033 - Agenda Bloqueios com recorrencia finita

**DRI:** backend-senior

**Jira:** a definir

**Apetite:** medio; extensao incremental do canario Dragon, com schema pequeno e UI de alto cuidado

**Status:** proposta documentada; sem codigo de app/db nesta branch

**ADRs relacionados:** 0018, 0024, 0031 e 0034

## PR-FAQ

### Press release

A Startap passa a permitir que o dono ou colaborador crie bloqueios recorrentes de agenda sem sair
do portal. Almoco semanal, ferias em dias repetidos, ausencia mensal ou indisponibilidade sazonal
podem ser criados em uma unica acao, sempre com previa antes de gravar e com limite finito.

O primeiro rollout continua restrito ao canario Dragon. O usuario escolhe a periodicidade, confere
cada ocorrencia que sera criada e confirma. O sistema cria eventos independentes no Google Calendar,
ligados internamente por uma mesma serie, sem usar RRULE e sem recorrencia infinita.

### FAQ

**Q: Por que agora?**
A: O MVP de bloqueios ja esta LIVE no Dragon, mas exige criar cada bloqueio manualmente. A proxima
friccao real e recorrencia operacional simples: almocos, folgas e indisponibilidades previsiveis.

**Q: O que muda para o usuario?**
A: No formulario de bloqueio, ele pode escolher "sem recorrencia" ou uma recorrencia semanal,
mensal, trimestral ou semestral, com quantidade finita entre 2 e 24 ocorrencias. Antes de confirmar,
ve uma previa completa e sequencial das ocorrencias.

**Q: Por que nao usar RRULE do Google Calendar?**
A: Porque RRULE desloca a verdade da serie para o GCal, complica remocao parcial, sync, auditoria e
rollback. A decisao e criar eventos GCal independentes e ligar as linhas internas por `serie_id`.

**Q: O que acontece ao remover uma serie?**
A: A acao em serie remove somente ocorrencias futuras e ativas. Ocorrencias passadas ficam como
historico/auditoria. A remocao individual continua removendo uma ocorrencia.

**Q: Como medimos sucesso?**
A: Dragon cria, lista e remove recorrencia curta sem evento orfao no GCal, sem impacto em
atendimentos/faturamento e sem liberar a feature para outros slots.

## Escopo

- Recorrencia finita com `quantidade` entre 2 e 24.
- Periodicidades: `semanal`, `mensal`, `trimestral`, `semestral`.
- Previa obrigatoria antes de gravar, retornando todas as ocorrencias planejadas.
- Criacao sequencial das ocorrencias; falha no meio deve reportar exatamente o que foi criado e
  permitir rollback operacional seguro.
- Eventos GCal independentes, cada um com marker privado de bloqueio e ligacao por `serie_id`.
- Remocao em serie apenas de ocorrencias futuras, preservando passado.
- Rollout no gate existente de Agenda Bloqueios, sem nova flag.

## Fora de escopo

- Recorrencia infinita, RRULE, excecoes complexas e edicao de serie.
- CRM, WhatsApp manual, automacoes de aniversario/sem-retorno e qualquer contato com cliente final.
- Rollout global, nova flag, novo worker ou fila dedicada.
- Mudanca no reconciler GCal->atendimentos fora do necessario para manter bloqueios ignorados.
- Reescrever a tela de agenda ou mudar formatos de clone.

## Contratos

### API

- `POST /portal/agenda/bloqueios/preview` valida os mesmos campos do bloqueio simples mais
  `recorrencia?: { periodicidade, quantidade }` e nao grava estado.
- `quantidade` aceita somente inteiros `2..24`; ausencia de `recorrencia` preserva o fluxo atual.
- A resposta de preview retorna `serie_id` provisorio, ocorrencias ordenadas, datas de inicio/fim,
  profissional, tipo, titulo/motivo e conflitos conhecidos pelo motor core existente.
- A criacao recebe um token/assinatura da previa ou revalida a previa byte-equivalente antes de
  gravar; o servidor nunca confia em uma lista de ocorrencias vinda do cliente.
- Acoes mutantes sao sequenciais: criar ocorrencia N+1 so depois de confirmar DB+GCal da ocorrencia
  N. Nada de `Promise.all` contra GCal.
- Endpoints de remocao devem separar claramente `remover uma ocorrencia` e `remover futuras da
  serie`.

### Dados

- `agenda_bloqueios` passa a aceitar `serie_id` nullable. Bloqueio avulso tem `serie_id = NULL`.
- Ocorrencias de uma serie compartilham `serie_id`; cada linha mantem seu proprio periodo,
  `gcal_event_id`, `deleted_at`, `deleted_reason` e trilha de autoria.
- Se houver colunas auxiliares como ordem/total, elas sao derivadas da criacao e nunca usadas para
  autorizar acesso; isolamento continua por `tenant_id`/`slot`/sessao.
- Nenhum `DROP`, `DELETE` ou `TRUNCATE`; remocao segue soft-delete.

### Google Calendar

- Cada ocorrencia cria um evento GCal independente, sem `recurrence`/RRULE.
- `extendedProperties.private.kind = 'bloqueio'` permanece obrigatorio para o sync ignorar.
- `extendedProperties.private.serie_id` deve existir nas ocorrencias recorrentes.
- Falha de GCal em criacao/remocao deve deixar log operacional com `slot`, hash/ID tecnico do
  evento quando houver e sem telefone/PII.

### Frontend

- UI exige previa antes de habilitar confirmacao.
- O usuario deve ver quantidade total, periodicidade, primeira e ultima ocorrencia e lista
  escaneavel das datas.
- Acoes destrutivas distinguem "esta ocorrencia" de "futuras desta serie".
- Texto e controles devem caber em mobile e desktop; smoke visual humano no Dragon e obrigatorio.

## Riscos

| Risco | Mitigacao |
|---|---|
| duplicar ou pular evento GCal | criacao sequencial, idempotencia por `serie_id`+inicio e teste de retry |
| serie parcial por falha externa | resposta explicita com criados/falhos e runbook para remover futuras |
| remover passado sem querer | predicado `inicio_at > now()` e teste com passado/presente/futuro |
| vazamento cross-tenant | slot da sessao, `tenant_id` em queries e testes anti-IDOR |
| sync transformar bloqueio em atendimento | marker privado preservado e teste no `gcal-atend-sync` |
| UX confirmar sem entender impacto | preview obrigatorio e smoke humano no navegador |

## Rollback

1. Reverter a PR de codigo e manter o gate atual de Agenda Bloqueios restrito ao Dragon.
2. Se houver migration aditiva, manter colunas/tabelas novas sem uso; nao dropar em rollback quente.
3. Para serie criada no canario, usar remocao de futuras pela propria feature ou script operacional
   revisado para soft-delete + remover eventos GCal futuros.
4. Validar que bloqueios avulsos antigos continuam listando/removendo e que o sync ignora markers.

## Definition of Done

- [ ] PR-FAQ e missao aprovados pelo PM/Bruno antes de implementacao.
- [ ] Backend valida `2..24`, periodicidades permitidas e preview obrigatorio.
- [ ] Criacao avulsa atual permanece compativel.
- [ ] Serie cria N linhas e N eventos GCal independentes ligados por `serie_id`.
- [ ] Falha na ocorrencia intermediaria nao cria concorrencia paralela nem perde evidencia.
- [ ] Remocao de serie afeta somente ocorrencias futuras e ativas.
- [ ] `gcal-atend-sync` continua ignorando bloqueios e nao cria `atendimentos`.
- [ ] Testes cobrem owner/colaborador, anti-IDOR, retry, soft-delete, passado/futuro e limites 1/2/24/25.
- [ ] CI completo verde: build/typecheck, Vitest raiz, painel quando aplicavel, E2E Compose se tocar fluxo vertical.
- [ ] Review `qa-tester` verde, incluindo regressao visual de agenda.
- [ ] Review `security` verde, incluindo isolamento, CSRF/auth, logs sem PII e abuso de `serie_id`.
- [ ] Smoke visual humano no Dragon em desktop e mobile: preview, criar serie curta, remover futuras.
- [ ] Evidencias de producao anexadas: SHA, CI, deploy, flags/gate lidos do container, IDs tecnicos
  sanitizados dos eventos criados/removidos, contagem final de bloqueios ativos e zero impacto em outros slots.

## Evidencias esperadas em producao

- `AGENDA_BLOQUEIOS_ENABLED=true` e `AGENDA_BLOQUEIOS_SLOTS=clone_barber_dragon_caly8b`, medidos no
  container antes do smoke.
- Dragon retorna 200 para bloqueios recorrentes; tenant fora do gate retorna `feature_off`.
- Serie de teste curta cria exatamente N bloqueios ativos e N eventos GCal com marker `bloqueio`.
- Remover futuras zera apenas as ocorrencias futuras da serie de teste.
- Logs do worker/API nao mostram erro no sync nem atendimento derivado de bloqueio.

## Waiver de ADR

ADR novo nao e necessario nesta etapa porque a decisao e aditiva dentro dos contratos ja aceitos de
Agenda/GCal: Service Account por clone, sync que ignora bloqueios e isolamento por tenant/slot. Um
ADR passa a ser obrigatorio se a implementacao introduzir RRULE, recorrencia infinita, fila nova,
worker novo, mudanca no modelo de faturamento ou refactor de formato acima de 300 linhas.
