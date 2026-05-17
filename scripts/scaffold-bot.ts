/**
 * scaffold-bot — CLI para criar clones de bots a partir das matrizes Startap.
 *
 * Uso:
 *   npm run scaffold-bot -- --help
 *   npm run scaffold-bot -- --from teste_barbearia --slot nome_cliente --phone 5511999999999
 *   npm run scaffold-bot -- --from teste_barbearia --slot nome_cliente --dry-run
 *
 * Reusa:
 *   - packages/db flowClones.createClone() para toda a lógica de DB (transação única)
 *   - packages/integrations waha.sessions.createSession() para criar sessão WAHA
 */

import { flowClones, closePool } from '@startap/db';
// Importa apenas o sub-módulo WAHA para evitar inicialização do cliente OpenAI
import * as wahaSessions from '@startap/integrations/waha';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MATRIZES_VALIDAS = [
  'teste_barbearia',
  'teste_vendas',
  'teste_vendas_barbearia',
] as const;

type MatrizSlot = (typeof MATRIZES_VALIDAS)[number];

// ---------------------------------------------------------------------------
// Parse de args
// ---------------------------------------------------------------------------

interface ScaffoldArgs {
  from: MatrizSlot;
  slot: string;
  phone: string | null;
  displayName: string;
  dryRun: boolean;
  criarSessaoWaha: boolean;
}

function parseArgs(argv: string[]): ScaffoldArgs | null {
  const args = argv.slice(2); // remove "node" e caminho do script

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return null;
  }

  function flag(name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1) return undefined;
    return args[idx + 1];
  }

  const from = flag('--from');
  const slot = flag('--slot');
  const phone = flag('--phone') ?? null;
  const displayName = flag('--name') ?? slot ?? '';
  const dryRun = args.includes('--dry-run');
  const semWaha = args.includes('--no-waha');

  if (!from) {
    erro('--from obrigatório. Exemplo: --from teste_barbearia');
    return null;
  }
  if (!(MATRIZES_VALIDAS as readonly string[]).includes(from)) {
    erro(`--from inválido: "${from}". Valores aceitos: ${MATRIZES_VALIDAS.join(', ')}`);
    return null;
  }
  if (!slot) {
    erro('--slot obrigatório. Exemplo: --slot barbearia_do_joao');
    return null;
  }
  if (!/^[a-z0-9_]{2,60}$/.test(slot)) {
    erro('--slot deve conter apenas letras minúsculas, números e _ (2–60 caracteres)');
    return null;
  }

  return {
    from: from as MatrizSlot,
    slot,
    phone,
    displayName: displayName || slot,
    dryRun,
    criarSessaoWaha: !semWaha,
  };
}

// ---------------------------------------------------------------------------
// Helpers de output
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stdout.write(`[scaffold-bot] ${msg}\n`);
}

function erro(msg: string): void {
  process.stderr.write(`[scaffold-bot] ERRO: ${msg}\n`);
}

function printHelp(): void {
  const txt = `
scaffold-bot — Cria clone de bot a partir de uma matriz Startap.

USO
  npm run scaffold-bot -- [flags]

FLAGS OBRIGATÓRIAS
  --from  <matriz>   Matriz origem: teste_barbearia | teste_vendas | teste_vendas_barbearia
  --slot  <slug>     Identificador único do novo bot (somente: a-z 0-9 _)

FLAGS OPCIONAIS
  --name  <texto>    Nome de exibição (padrão: valor de --slot)
  --phone <número>   Telefone do cliente (ex: 5511999999999). Só informativo.
  --no-waha          Pula criação de sessão WAHA (útil pra testar só o DB)
  --dry-run          Exibe o plano sem executar nada
  -h, --help         Exibe esta ajuda

EXEMPLOS
  # Clona barbearia, cria sessão WAHA
  npm run scaffold-bot -- --from teste_barbearia --slot barbearia_silva --name "Barbearia Silva"

  # Dry-run — confere o plano sem tocar no banco
  npm run scaffold-bot -- --from teste_barbearia --slot barbearia_silva --dry-run

  # Cria apenas o registro no banco (sem sessão WAHA ainda)
  npm run scaffold-bot -- --from teste_vendas --slot vendas_maria --no-waha

VARIÁVEIS DE AMBIENTE NECESSÁRIAS
  PG_HOST, PG_PORT, PG_USER, PG_PASS, PG_DB   — conexão Postgres
  WAHA_URL, WAHA_API_KEY                        — integração WAHA (se --no-waha não for usado)
`.trimStart();
  process.stdout.write(txt);
}

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

function printDryRun(args: ScaffoldArgs): void {
  log('MODO DRY-RUN — nenhuma operação será executada.\n');
  log('Plano de execução:');
  log(`  1. Validar que "${args.from}" existe em bot_config (SELECT)`);
  log(`  2. Validar que slot "${args.slot}" NÃO existe em flow_clones (SELECT)`);
  log(`  3. BEGIN transação Postgres`);
  log(`     a. INSERT bot_config (slot="${args.slot}", display_name="${args.displayName}", copia provider/model/temperature de "${args.from}")`);
  log(`     b. INSERT bot_prompt (copia prompt de "${args.from}", aplica personalizacao={})` );
  log(`     c. INSERT bot_media (copia todas as medias de "${args.from}")`);
  log(`     d. INSERT flow_controls (flow_id="${args.slot}", source='clone', active=TRUE)`);
  log(`     e. INSERT flow_clones (slot="${args.slot}", matriz_slot="${args.from}", status='rascunho'${args.phone ? `, cliente_telefone="${args.phone}"` : ''})`);
  log(`  4. COMMIT`);
  if (args.criarSessaoWaha) {
    log(`  5. POST ${process.env.WAHA_URL ?? 'http://waha:3000'}/api/sessions { name: "${args.slot}", start: true }`);
    log(`  6. UPDATE flow_clones SET waha_sessao="${args.slot}", status='aguardando_qr'`);
  } else {
    log(`  5. (criação de sessão WAHA pulada — --no-waha)`);
  }
  log(`\nBot resultante: slot="${args.slot}", matriz="${args.from}"`);
  log('Para executar de verdade, remova --dry-run.');
}

// ---------------------------------------------------------------------------
// Execução real
// ---------------------------------------------------------------------------

async function validarSlotLivre(slot: string): Promise<void> {
  const existente = await flowClones.getCloneBySlot(slot);
  if (existente !== null) {
    throw new Error(
      `scaffold-bot: validação: slot "${slot}" já existe em flow_clones (id=${existente.id}). ` +
        'Escolha outro --slot ou delete o clone existente pelo painel.',
    );
  }
}

async function executar(args: ScaffoldArgs): Promise<void> {
  log(`Iniciando clonagem: ${args.from} → ${args.slot}`);

  // Valida slot livre antes de tentar criar (createClone já valida a matriz via FK)
  log('Verificando disponibilidade do slot...');
  await validarSlotLivre(args.slot);
  log(`Slot "${args.slot}" disponível.`);

  // Cria o clone no banco (transação atômica em packages/db)
  log('Criando clone no banco de dados...');
  const clone = await flowClones.createClone({
    matrizSlot: args.from,
    displayName: args.displayName,
    clienteNome: null,
    clienteTelefone: args.phone,
    personalizacao: {},
  });
  log(`Clone criado: id=${clone.id}, slot="${clone.slot}", status="${clone.status}"`);

  // Cria sessão WAHA se solicitado
  if (args.criarSessaoWaha) {
    log(`Criando sessão WAHA "${args.slot}"...`);
    try {
      const sessao = await wahaSessions.sessions.createSession(args.slot);
      // Vincula sessão ao clone no banco
      await flowClones.setCloneSession(clone.id, args.slot);
      log(`Sessão WAHA criada. Status: ${sessao.status}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Sessão WAHA falha NÃO reverte o clone — operador pode vincular depois pelo painel
      erro(`Falha ao criar sessão WAHA: ${msg}`);
      log('AVISO: clone criado no banco, mas sessão WAHA pendente. Use o painel para vincular.');
      log(`Próximo passo: painel → Clones → ${clone.slot} → Vincular Sessão`);
      process.exitCode = 1;
      return;
    }
    log('');
    log('=== Clone criado com sucesso ===');
    log(`  Slot:          ${clone.slot}`);
    log(`  Matriz:        ${args.from}`);
    log(`  Display Name:  ${args.displayName}`);
    log(`  Sessão WAHA:   ${args.slot} (aguardando QR)`);
    log(`  Status:        aguardando_qr`);
    if (args.phone) log(`  Telefone:      ${args.phone}`);
    log('');
    log('Próximo passo: acesse o painel → Clones → escaneie o QR da sessão.');
  } else {
    log('');
    log('=== Clone criado com sucesso ===');
    log(`  Slot:          ${clone.slot}`);
    log(`  Matriz:        ${args.from}`);
    log(`  Display Name:  ${args.displayName}`);
    log(`  Sessão WAHA:   (não criada — use o painel para vincular)`);
    log(`  Status:        ${clone.status}`);
    if (args.phone) log(`  Telefone:      ${args.phone}`);
    log('');
    log('Próximo passo: painel → Clones → Vincular Sessão WAHA.');
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args === null) {
    // help ou erro de parse — não usa DB
    return;
  }

  if (args.dryRun) {
    printDryRun(args);
    return;
  }

  try {
    await executar(args);
  } finally {
    // Fecha o pool do Postgres mesmo se houver erro
    await closePool();
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  erro(msg);
  process.exit(1);
});
