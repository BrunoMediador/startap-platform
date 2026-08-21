/**
 * Expansão de datas de uma série recorrente de agendamento (SCRUM — "agenda recorrente").
 *
 * Sem I/O — função pura, testável sem mock de banco/rede/GCal.
 *
 * MODELAGEM (decidida, não RRULE): cada ocorrência vira um evento GCal INDEPENDENTE
 * (ver ADR 0027 §"eventos independentes"). Este módulo só calcula as `data` (YYYY-MM-DD)
 * de cada ocorrência a partir de uma data-âncora + periodicidade + quantidade — a hora
 * é sempre a mesma da âncora (não muda por ocorrência), e toda validação de
 * disponibilidade/horário de funcionamento acontece DEPOIS, no caller (helper `avaliarSlot`
 * do portal-api), nunca aqui.
 */

export const PERIODICIDADES = ['diaria', 'semanal', 'mensal', 'trimestral', 'semestral'] as const;
export type Periodicidade = (typeof PERIODICIDADES)[number];

/** Cap duro de ocorrências por lote — risco de rate-limit do GCal (N chamadas events.insert). */
export const OCORRENCIAS_MIN = 2;
export const OCORRENCIAS_MAX = 24;

/** Meses a somar por periodicidade (diaria/semanal usam dias, tratados à parte). */
const MESES_POR_PERIODICIDADE: Record<Exclude<Periodicidade, 'diaria' | 'semanal'>, number> = {
  mensal: 1,
  trimestral: 3,
  semestral: 6,
};

/**
 * Quantos dias tem o mês `(anoBase, mesBase)` — mesBase 0-indexado (0=jan..11=dez),
 * tolerante a overflow (mesBase=12 → janeiro do ano seguinte), que é exatamente como
 * `addMeses` chama esta função.
 */
function diasNoMes(anoBase: number, mesBase: number): number {
  // dia 0 do mês seguinte = último dia do mês (anoBase, mesBase) em UTC wall-clock.
  return new Date(Date.UTC(anoBase, mesBase + 1, 0)).getUTCDate();
}

/**
 * Soma `meses` a uma data (YYYY-MM-DD), com CLAMP no último dia do mês de destino
 * quando o dia de origem não existe nele (decisão do Bruno: 31/01 + 1 mês = 28/02
 * [ou 29/02 em bissexto], não "estoura" pro dia 3 de março como o `Date` nativo faria).
 *
 * Vale para mensal (+1), trimestral (+3) e semestral (+6) — a mesma função, variando
 * só o incremento. Trabalha em componentes de calendário puros (UTC wall-clock, sem
 * fuso) porque a entrada é uma DATA (YYYY-MM-DD), não um instante — fuso é resolvido
 * depois pelo caller ao converter data+hora em instante absoluto (zonedWallTimeToUtc).
 */
function addMeses(dataKey: string, meses: number): string {
  const [anoStr, mesStr, diaStr] = dataKey.split('-');
  const ano = Number(anoStr);
  const mesIdx = Number(mesStr) - 1; // 0-indexado
  const dia = Number(diaStr);

  const totalMesesIdx = mesIdx + meses;
  const novoAno = ano + Math.floor(totalMesesIdx / 12);
  const novoMesIdx = ((totalMesesIdx % 12) + 12) % 12;

  const ultimoDiaDoMesDestino = diasNoMes(novoAno, novoMesIdx);
  const novoDia = Math.min(dia, ultimoDiaDoMesDestino);

  const yyyy = String(novoAno).padStart(4, '0');
  const mm = String(novoMesIdx + 1).padStart(2, '0');
  const dd = String(novoDia).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Soma `dias` a uma data (YYYY-MM-DD), em componentes de calendário puros (UTC wall-clock). */
function addDias(dataKey: string, dias: number): string {
  const [ano, mes, dia] = dataKey.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  d.setUTCDate(d.getUTCDate() + dias);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Expande a data-âncora (YYYY-MM-DD) em `ocorrencias` datas, incluindo a própria âncora
 * como 1ª ocorrência (índice 0). A hora é a mesma em todas — cabe ao caller anexá-la.
 *
 * `ocorrencias` fora de [OCORRENCIAS_MIN, OCORRENCIAS_MAX] lança — o schema Zod do
 * endpoint já capa isso antes de chegar aqui; a validação aqui é defesa em profundidade
 * (esta função é exportada e pode ser chamada direto em teste/outro caller futuro).
 */
export function expandirDatas(
  dataAncora: string,
  periodicidade: Periodicidade,
  ocorrencias: number,
): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataAncora)) {
    throw new Error(`dataAncora invalida (esperado YYYY-MM-DD): ${dataAncora}`);
  }
  if (
    !Number.isInteger(ocorrencias) ||
    ocorrencias < OCORRENCIAS_MIN ||
    ocorrencias > OCORRENCIAS_MAX
  ) {
    throw new Error(
      `ocorrencias fora do intervalo [${OCORRENCIAS_MIN}, ${OCORRENCIAS_MAX}]: ${ocorrencias}`,
    );
  }

  const datas: string[] = [dataAncora];
  for (let i = 1; i < ocorrencias; i++) {
    if (periodicidade === 'diaria') {
      datas.push(addDias(dataAncora, i));
    } else if (periodicidade === 'semanal') {
      datas.push(addDias(dataAncora, i * 7));
    } else {
      datas.push(addMeses(dataAncora, i * MESES_POR_PERIODICIDADE[periodicidade]));
    }
  }
  return datas;
}
