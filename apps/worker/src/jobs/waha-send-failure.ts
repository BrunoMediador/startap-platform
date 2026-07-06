/**
 * Taxonomia de falha de envio WAHA — RE-EXPORT do @startap/core (SCRUM-53 → movido em SCRUM-59).
 *
 * A função virou FONTE ÚNICA no core (`@startap/core/waha-send-failure`) pra ser reusada também
 * pelo apps/api (owner-alert/client-alert), que não pode importar do worker. Este arquivo mantém
 * o caminho de import histórico do worker (client-disconnect-notify/monitor + o teste local).
 */
export { isDefinitiveNonDelivery } from '@startap/core/waha-send-failure';
