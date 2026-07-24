import { normalizePhone } from './format';

/**
 * Predicado de busca de um pausado na tela de Pausas. Casa por NÚMERO **ou** por
 * NOME. Extraído do componente pra ser testável sem DOM (harness pure-fn do portal).
 *
 * Regra crítica (regressão evitada): a busca por NÚMERO casa contra os dígitos do
 * número **ORIGINAL** (o que o dono VÊ em `formatPhoneDisplay` e digita — inclui o
 * "9" do celular), NÃO contra a chave de join `normalizePhone` (que é invariante ao
 * 9º dígito). Se usasse a chave, digitar "99115" de um `(35) 99115-3270` não acharia
 * nada, porque a chave é de-9'd (`3591153270`). O `normalizePhone` só serve pra
 * RESOLVER o nome (join contatos↔pausas); a busca é sobre o número visível.
 *
 * @param telefone  telefone cru da pausa (como veio de /portal/pausas)
 * @param nomeResolvido nome já resolvido pelo join (ou null se desconhecido)
 * @param busca     texto digitado pelo dono
 */
export function pausaMatchesBusca(
  telefone: string,
  nomeResolvido: string | null | undefined,
  busca: string,
): boolean {
  if (busca.trim() === '') return true;
  const buscaDigitos = busca.replace(/\D/g, '');
  const buscaTexto = busca.trim().toLowerCase();

  // NÚMERO: dígitos crus do original (o que o dono vê/digita), não a chave de-9'd.
  const telDigitos = telefone.replace(/\D/g, '');
  const porNumero = buscaDigitos.length > 0 && telDigitos.includes(buscaDigitos);

  // NOME: usa o nome já resolvido via chave de join invariante ao 9º dígito.
  const nome = nomeResolvido?.trim().toLowerCase();
  const porNome = nome ? nome.includes(buscaTexto) : false;

  return porNumero || porNome;
}

/**
 * Chave de join telefone->nome usada pela tela (re-export semântico do
 * `normalizePhone`, invariante ao 9º dígito). Fica aqui pra deixar explícito, no
 * ponto de uso, QUAL chave nomeia — separada da busca-por-número acima.
 */
export function chaveJoinPausa(telefone: string): string {
  return normalizePhone(telefone);
}
