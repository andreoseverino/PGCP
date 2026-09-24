import { existsSync } from "node:fs";

/*
 * Carrega o `.env` (se existir) antes de qualquer modulo ler `process.env`.
 * Importar como PRIMEIRO import do ponto de entrada: `database.ts` le as
 * variaveis ja na importacao. Variavel definida no ambiente tem precedencia
 * sobre o arquivo, como no antigo `dotenv/config`. Requer Node >= 20.12.
 */
if (existsSync(".env")) process.loadEnvFile();
