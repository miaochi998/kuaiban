-- 按排期日查（日历视图、某天的待办）
CREATE INDEX IF NOT EXISTS idx_todos_date ON todos(date);
