/**
 * Fila FIFO em memória para uma conversa específica.
 *
 * O webhook WAHA pode admitir mensagens consecutivas em paralelo. A memória
 * conversacional, porém, é read-after-write: a próxima mensagem só pode montar
 * seu prompt depois de a anterior registrar a resposta. Esta fila serializa
 * esse trecho sem bloquear conversas de outros slots/telefones.
 *
 * Não é mecanismo de entrega nem lock distribuído: a API hoje roda em uma
 * instância e o dedup de eventos continua no caminho de ingestão. Se houver
 * scale-out, a serialização precisa migrar para um primitivo compartilhado.
 */
export class ConversationRunner {
  private readonly tails = new Map<string, Promise<void>>();

  /** Quantas conversas possuem trabalho em execução ou aguardando sua vez. */
  get size(): number {
    return this.tails.size;
  }

  /**
   * Executa uma tarefa após a anterior da mesma chave, preservando a fila mesmo
   * quando uma tarefa falha. A chave é construída pelo caller com o mesmo escopo
   * da memória do bot (slot, sessão, fluxo e telefone).
   */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
