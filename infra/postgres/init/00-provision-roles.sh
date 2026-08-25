#!/bin/sh
# =============================================================================
# 00-provision-roles.sh — provisiona os papeis do PGCP em cluster LIMPO.
#
# Roda UMA vez, automaticamente, quando o container do PostgreSQL inicializa um
# diretorio de dados vazio (mecanismo /docker-entrypoint-initdb.d da imagem
# oficial). Executa como o superusuario de bootstrap (POSTGRES_USER), que aqui
# NAO e o papel da aplicacao.
#
# Cria pcgp_admin (migration/dono) e pcgp_app (runtime, menor privilegio) a
# partir de provision-roles.sql. As tabelas e seus grants vem depois, quando as
# migrations rodam como pcgp_admin (a migration 015 concede o DML de runtime).
#
# Senhas vem do ambiente do container (nunca ficam no repositorio):
#   PCGP_APP_PASSWORD    -> senha de pcgp_app  (igual a DB_PASSWORD da API)
#   PCGP_ADMIN_PASSWORD  -> senha de pcgp_admin (igual a DB_MIGRATION_PASSWORD)
# =============================================================================
set -e

if [ -z "$PCGP_APP_PASSWORD" ] || [ -z "$PCGP_ADMIN_PASSWORD" ]; then
  echo "[provision] ERRO: PCGP_APP_PASSWORD e PCGP_ADMIN_PASSWORD sao obrigatorias." >&2
  exit 1
fi

echo "[provision] criando papeis pcgp_admin e pcgp_app no banco ${POSTGRES_DB}..."

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v app_db="$POSTGRES_DB" \
  -v app_password="$PCGP_APP_PASSWORD" \
  -v admin_password="$PCGP_ADMIN_PASSWORD" \
  -f /pgcp-provision/provision-roles.sql

echo "[provision] papeis provisionados. As migrations (como pcgp_admin) criam as tabelas e a 015 concede o DML de runtime."
