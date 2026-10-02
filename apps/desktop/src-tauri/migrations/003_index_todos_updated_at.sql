-- 按更新时间查（同步时增量拉取"某时刻之后变过的记录"）
CREATE INDEX IF NOT EXISTS idx_todos_updated_at ON todos(updated_at);
