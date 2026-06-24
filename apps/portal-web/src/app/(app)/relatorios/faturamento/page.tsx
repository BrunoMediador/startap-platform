import { redirect } from 'next/navigation';

/**
 * Faturamento foi consolidado na tela ÚNICA /billing (Faturamento + Comissão num só
 * lugar, com seletor Previsão|Faturado controlando a página inteira). Esta rota só
 * existe pra não quebrar links antigos (bookmarks, /atendimentos/novo legado) —
 * redireciona pra /billing.
 */
export default function FaturamentoRedirect() {
  redirect('/billing');
}
