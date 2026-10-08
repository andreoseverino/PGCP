-- =============================================================================
-- 041_annual_agenda_direct_approval.sql
--
-- APROVAÇÃO DIRETA da Agenda Anual (10/2026): volta a existir aprovação, mas
-- SEM envio por e-mail. A Assessoria marca "Aprovada" e o PGCP grava a versão
-- (snapshot) já aprovada, de uma vez — não há destinatário.
--
-- `annual_agenda_versions.sent_to` deixa de ser obrigatório: NULL = versão
-- aprovada diretamente no PGCP; preenchido = envio por e-mail (antes de
-- 10/2026, histórico). O CHECK de tamanho continua valendo quando há valor
-- (CHECK com NULL passa).
--
-- Nada mais muda: trigger de imutabilidade (028) só olha UPDATE/DELETE, o
-- índice de "no máximo uma aprovada por agenda" segue valendo (aprovada trava
-- de vez) e os privilégios de pcgp_app (SELECT, INSERT) já bastam.
--
-- REVERSÃO (manual): só se nenhuma versão tiver sent_to NULL.
--   ALTER TABLE annual_agenda_versions ALTER COLUMN sent_to SET NOT NULL;
--
-- Aplicada dentro de uma transação pelo runner: NÃO incluir BEGIN/COMMIT aqui.
-- =============================================================================

ALTER TABLE annual_agenda_versions ALTER COLUMN sent_to DROP NOT NULL;

COMMENT ON COLUMN annual_agenda_versions.sent_to IS
  'E-mail do aprovador (envio antes de 10/2026). NULL = aprovação registrada diretamente no PGCP.';
