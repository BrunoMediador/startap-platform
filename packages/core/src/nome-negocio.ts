/**
 * resolveNomeNegocio — nome AMIGÁVEL do negócio (nunca o slug técnico do clone).
 *
 * Fonte única compartilhada (SCRUM-92 inc.2 / ADR 0032): o builder conversacional
 * (portal-api) usa pra abrir a entrevista/persona e o caminho do bot (apps/api, via
 * db.getAreaPromptCustomCartao) usa pra cabear o `<nome do negócio>` do cartão montado
 * em RUNTIME. Antes vivia SÓ em apps/portal-api/routes/prompt-builder.ts; extraída pra
 * @startap/core pra os dois consumirem a MESMA regra (sem drift).
 *
 * Preferência: nome_negocio do "Meu negócio" (personalizacao.nome_negocio) > display_name
 * > cliente_nome > genérico. Evita valor "slug-like" (sem espaço, só [a-z0-9._-]): na 1ª
 * passada só aceita candidato com cara de nome de verdade; se TODOS forem slug, cai pro de
 * maior prioridade não-vazio antes do fallback genérico. Sem isso a persona/cartão abriria
 * com o SLUG do clone ("cirilobarbearia") em vez do nome real. SCRUM-92 (bug 4).
 *
 * PURA/determinística — sem I/O, testável em node.
 */

/** "slug-like" = sem espaço e só [a-z0-9._-] (ex.: "cirilobarbearia", "barber_dragon" —
 *  nome TÉCNICO do clone), não um nome amigável de negócio. */
function looksSlugLike(s: string): boolean {
  return !/\s/.test(s) && /^[a-z0-9._-]+$/.test(s);
}

export function resolveNomeNegocio(clone: {
  display_name?: string | null;
  cliente_nome?: string | null;
  personalizacao?: Record<string, string> | null;
}): string {
  const candidates = [clone.personalizacao?.nome_negocio, clone.display_name, clone.cliente_nome];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && !looksSlugLike(v)) return v;
  }
  for (const c of candidates) {
    const v = c?.trim();
    if (v) return v;
  }
  return 'seu negócio';
}
