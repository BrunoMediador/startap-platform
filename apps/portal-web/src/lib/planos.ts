/**
 * Lógica pura da seção "Planos e assinaturas" (modo atendente, SCRUM-59) da tela Meu
 * negócio. Sem React/DOM — testável.
 *
 * O dono descreve, em TEXTO LIVRE, os planos/assinaturas/benefícios da barbearia. Esse
 * texto cai no contexto do bot pela personalização existente — o assistente passa a
 * responder sobre planos usando exatamente o que estiver aqui.
 *
 * CONTRATO (backend em preparação, padrão do link_agendamento):
 *   GET  /portal/perfil -> { perfil: { planos_beneficios? }, features?: { modo_atendente } }
 *   PUT  /portal/perfil body { perfil: { planos_beneficios } }  (parcial; '' LIMPA).
 * Exposto só com features.modo_atendente=true; ausente no GET (feature off) = ''.
 */
import type { PlanosConfig } from './api-types';

/** Limite de caracteres do texto de planos (espelha o max do backend). */
export const PLANOS_MAX = 4000;

export interface PlanosDraft {
  planos_beneficios: string;
}

/** Resposta (flat) do backend -> draft de UI. Campo ausente/null -> ''. */
export function toPlanosDraft(data: Partial<PlanosConfig> | null | undefined): PlanosDraft {
  const p = data?.planos_beneficios;
  return { planos_beneficios: typeof p === 'string' ? p : '' };
}

/** Nº de caracteres do texto (base do contador). */
export function planosLength(texto: string): number {
  return texto.length;
}

/** Quantos caracteres ainda cabem (pode ficar negativo = passou do limite). */
export function planosRestante(texto: string): number {
  return PLANOS_MAX - texto.length;
}

/** Válido pra salvar? (só o limite de tamanho — texto livre, vazio é permitido = limpa). */
export function isPlanosValido(texto: string): boolean {
  return texto.length <= PLANOS_MAX;
}

/**
 * Valor pronto pro PUT: apara só as bordas (preserva quebras de linha internas). Vazio
 * permanece '' (o backend trata como "limpar").
 */
export function toPlanosValue(draft: PlanosDraft): string {
  return draft.planos_beneficios.trim();
}

/** True quando o draft difere do salvo (libera o botão Salvar). Compara já aparado. */
export function isPlanosDirty(a: PlanosDraft, b: PlanosDraft): boolean {
  return a.planos_beneficios.trim() !== b.planos_beneficios.trim();
}
