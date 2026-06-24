import { redirect } from 'next/navigation';

/**
 * Comissão foi consolidada na tela ÚNICA /billing (aparece como a seção "Comissão
 * por profissional", só no estabelecimento, acompanhando o seletor Previsão|Faturado).
 * Esta rota só existe pra não quebrar links antigos — redireciona pra /billing.
 */
export default function ComissaoRedirect() {
  redirect('/billing');
}
