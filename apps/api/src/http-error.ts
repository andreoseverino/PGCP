/**
 * Erro com status HTTP. O service lanca, a rota traduz para resposta.
 *
 * A mensagem daqui e a unica coisa que chega ao cliente: nunca colocar detalhe
 * interno do PostgreSQL, nome de coluna ou stack aqui.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
