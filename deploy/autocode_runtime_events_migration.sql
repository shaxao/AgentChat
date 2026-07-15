-- AutoCode runtime event log field.
-- Safe to run repeatedly; ignore duplicate-column errors in deploy runner output.

ALTER TABLE autocode_tasks
  ADD COLUMN events JSON DEFAULT NULL;

