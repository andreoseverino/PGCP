import pool from "../database.js";

/**
 * Politica de LEITURA de reuniao — fonte unica.
 *
 * Existe para que nenhum outro modulo reimplemente "quem pode ver esta
 * reuniao". Quem herda visibilidade da reuniao (hoje o FUP) chama daqui; no dia
 * em que a regra apertar, aperta neste arquivo e vale para todos.
 *
 * POLITICA A — DECISAO DE PRODUTO, nao lacuna de implementacao.
 *
 *     Toda reuniao do PGCP e corporativamente visivel a qualquer usuario
 *     PGCP ativo.
 *
 * Aprovada na 5.4e depois de mapear o modelo real. Nao e o `TRUE` que sobrou de
 * um `WHERE` esquecido: e a regra escolhida, com dois motivos concretos.
 *
 * 1. Nao existe fonte de autorizacao por participacao. `meeting_participants`
 *    lista quem foi CONVIDADO — e, nos dados reais, dois tercos dos
 *    participantes sao snapshot textual, sem identidade nenhuma. Usar essa
 *    tabela como ACL negaria acesso a quem participa de verdade.
 * 2. Quem cadastra a reuniao, a Secretaria e quem prepara pauta consultam
 *    reunioes das quais nao participam. Uma regra por participacao quebraria
 *    esse trabalho em silencio.
 *
 * O PGCP **nao possui** hoje reuniao restrita ou confidencial: nao ha coluna de
 * classificacao em nenhuma tabela, e a interface nao trata nenhuma reuniao como
 * reservada. Quando houver requisito para sessoes reservadas, sera uma feature
 * propria — com coluna, regra explicita e decisao de quem classifica.
 *
 * ESTE MODULO CONTINUA EXISTINDO PRECISAMENTE POR ISSO. Ele da nome e endereco
 * unico a decisao: `clausulaDeReuniaoVisivel` devolve `TRUE` hoje, e no dia em
 * que a regra apertar, aperta AQUI — quem herda (o FUP, na 5.4c) aperta junto,
 * sem tocar em outro modulo. Espalhar o `TRUE` implicito pelas consultas e o que
 * tornaria impossivel responder "quem pode ver o que" sem reler o servidor.
 *
 * MUTACAO E OUTRA COISA: alterar reuniao exige a App Role `PGCP.Assessoria`,
 * verificada nas rotas. Poder ler nunca implicou poder escrever.
 */

export interface EspectadorPgcp {
  /** Identidade interna do PGCP. */
  userId: string;
  /** Identidade Microsoft, validada no token. */
  entraTenantId: string;
  entraObjectId: string | null;
}

/**
 * Fragmento SQL que restringe uma consulta as reunioes visiveis ao espectador.
 *
 * Devolve `TRUE` enquanto a leitura de reuniao for aberta a usuario ativo. O
 * chamador NAO precisa saber disso: ele compoe o fragmento no `WHERE` e ganha
 * de graca qualquer restricao futura.
 *
 * `alias` e o apelido da tabela `meetings` na consulta de quem chama; `bind`
 * registra parametros e devolve o placeholder correspondente.
 */
export function clausulaDeReuniaoVisivel(
  _alias: string,
  _espectador: EspectadorPgcp,
  _bind: (valor: unknown) => string,
): string {
  // Politica A: leitura corporativa. Os parametros existem para a regra futura
  // poder usa-los sem mudar nenhum chamador.
  return "TRUE";
}

/**
 * A reuniao existe E e visivel para o espectador?
 *
 * `false` tanto para "nao existe" quanto para "existe e nao pode": quem chama
 * responde 404 nos dois casos, e a diferenca entre eles nao vaza para fora.
 */
export async function podeVisualizarReuniao(
  meetingId: string,
  espectador: EspectadorPgcp,
): Promise<boolean> {
  const params: unknown[] = [meetingId];
  const bind = (valor: unknown) => {
    params.push(valor);
    return `$${params.length}`;
  };

  const { rows } = await pool.query(
    `SELECT 1
       FROM meetings m
      WHERE m.id = $1
        AND ${clausulaDeReuniaoVisivel("m", espectador, bind)}
      LIMIT 1`,
    params,
  );

  return rows.length > 0;
}
