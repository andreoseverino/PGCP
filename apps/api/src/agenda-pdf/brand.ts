/**
 * Identidade visual do PGCP no documento de validacao.
 *
 * PALETA: os mesmos tokens que a interface usa. Nao sao cores escolhidas aqui —
 * `#00658d` aparece em 295 lugares do frontend, `#00aeef` em 49. Manter o
 * documento na mesma paleta e o que faz o PDF parecer do PGCP, e nao um
 * relatorio tecnico qualquer.
 *
 * LOGO: o MESMO arquivo que `apps/web/src/logo.jpg` — o logo da Cielo ja
 * versionado no repositorio e ja usado no LoginView e na Sidebar.
 *
 * POR QUE EM BASE64, e nao lendo o arquivo:
 *
 *   `tsc` compila TypeScript e NAO copia asset binario para `dist/`. Um
 *   `readFileSync` de .jpg funcionaria com `tsx` em desenvolvimento e quebraria
 *   em producao, onde so existe o `dist`. Como constante, o compilador carrega
 *   junto e nao ha passo de build novo para alguem esquecer.
 *
 *   Contrapartida aceita: se o logo do frontend mudar, esta copia precisa ser
 *   regerada. Sao 6,5 KB e o arquivo diz de onde veio.
 *
 * NAO INVENTAR MARCA: nenhuma cor, fonte ou simbolo foi criado aqui. O que nao
 * existe no repositorio (tipografia Inter em arquivo, logo vetorial com fundo
 * transparente) esta registrado como pendencia, nao improvisado.
 */

/** Tokens da interface do PGCP. */
export const MARCA = {
  /** Azul institucional. Titulo, filete e rotulo de secao. */
  primaria: "#00658d",
  /** Ciano de destaque. Usado com parcimonia. */
  destaque: "#00aeef",
  /** Azul profundo. Texto de maior peso. */
  profunda: "#001e2d",
  /** Azul escuro intermediario. */
  media: "#003e58",
  /** Tinta de corpo de texto. */
  tinta: "#1F2937",
  tintaSuave: "#475569",
  tintaFraca: "#64748B",
  linha: "#E2E8F0",
  /** Fundo suave de bloco de informacao. */
  fundoSuave: "#F1F5F9",
} as const;

/**
 * Logo da Cielo (JPEG 225x225), identico a `apps/web/src/logo.jpg`.
 *
 * O arquivo tem fundo solido — nao ha versao vetorial nem com transparencia no
 * repositorio. Por isso e desenhado como bloco quadrado, e nao sobreposto a
 * outro fundo.
 */
const LOGO_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQ" +
  "ERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU" +
  "FBQUFBQUFBQUFBQUFBT/wAARCADhAOEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA" +
  "AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6" +
  "Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG" +
  "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA" +
  "AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5" +
  "OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE" +
  "xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5fooor9lPzwKKKKACiiigAooooAKKKKAC" +
  "iiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAC" +
  "iiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAC" +
  "iiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAC" +
  "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" +
  "066t/wChWX/xNfMnwY/aO8bfAG4u/wDhFdQtfsl3+9m0/UIPNtnf+9t3Kyt/utWJ8Vfi74n+M/ica74q1D7VdeV5cEUSeVBb" +
  "p/djX+H73+9V0strQzD6z9kieMhPC+xOQtruWwuIbm0lltLuGVZIZYvkZHVtysv+1uWv1L/ZO/a+0v406PZ+HPE1zHpfj2GM" +
  "I8Mh2R6lt/5aw/7X9+PqP92vyzpqSSwXHmRS+VLD+8SX7jI6/dZa9HHZfHGw97c5MLipYaR+4HxE+FPhP4taN/Zfi/QLTWbX" +
  "GU86P95Ef70ci/Mjf7rV8+3/APwTU+E9zfedDd+I7CL/AJ9Yb6N1/wC+pI2b/wAer5R+F/7ffxU+HsMVnqF3beL7CIY8rW1f" +
  "7Sif7NwvzN9ZN1eww/8ABVKUDEvw1i8338QbV/8ASWvlXl+ZYb3aJ7n1rCVvjPqL4Ufsr/DX4MTm78OeHojqhHOqag7XFyv+" +
  "6zfc/wCA7a539tbxp4Y8Nfs++LdO1+W1N1q9jLZ6bYTHMk9y3+rZV/2W2tu/h218meOP+CmHjzXraW28N6Bpfhb/AKeppGv5" +
  "1/3cqqq3+8rV8s+KfGGveO9fl1nxLqt1rWqy/furp9zf7q/3V/2V+WujC5RialVVsTI56uOpQhyUYmNX0Z/wT+k/4ye8O/8A" +
  "Xle/+iGr5zrS8NeJdT8Ha9p+u6Nfy2OqafItxbXMQyyt/lmX/gTV9Zi6Pt6E6aPGpT5Jwmfsl+0tJHF+z18R2kIjX/hH77P/" +
  "AH4avxbr234q/thfE74v+Ef+Ea1+/sLTS5QouYtKtfIa7C/89mZm+Xd/Cu1a8Sry8qwdTBwn7Q6cbiIYmfuH1T+xf+11F8F7" +
  "r/hEfFU0v/CFXcnmQ3J3M2mTN95tv/PFm+Z/7rHd/E1fppaz6X4t0YSwyW2q6XeRZSRCssM8Tf8AjrLX4RV6R8JP2ifiB8Eb" +
  "j/ildfli0/8A1j6Vdp59k/8A2zb7v+8rK1cuPyj6xP21D4jfC472MeSp8J+ifjT/AIJ+fCLxbfzXltpV/wCGppvv/wBiXXlR" +
  "/hG6si/8BWmeDP8Agn18IvClzHc3OnX/AIlcf8s9cuvNjP8AvRoqI30Za8J0P/gqVrUFsBrHw80++uh/y1tNVktV/wC+Whk/" +
  "9Cpdb/4Kla1Pb+XpXw8sLS6/563eqyXCr/wFYY//AEKvJ+qZr8Gv/gR6Pt8F8Z99uumeGdGwRaaVpVpF32wQQIv/AI6q1+VH" +
  "7Yfxq8K/E/x7NF4HtvL0qE/6ZqsPyLqcv95V/ur/AHv4q4P4t/tHfED435j8VeIPN0o8ppVonkWif9s1/wBZ/wBtGavNK93K" +
  "8tqYOftqk/ePHx9ejjfc5PhCn0UV9IecFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUA" +
  "FFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUA" +
  "FFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUA" +
  "FFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUA" +
  "FFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUA" +
  "FFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH//2Q==";

/** Bytes do logo, prontos para `doc.image()`. */
export const LOGO = Buffer.from(LOGO_BASE64, "base64");

/** Lado do logo no cabecalho, em pontos. */
export const LOGO_LADO = 38;
