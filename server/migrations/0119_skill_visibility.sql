-- Skill 可见范围（skill-creator-plan 4.5，SC4）：Skill 级配置，不随版本固定。
-- null 表示全员可见（存量 Skill 保持现有行为，不迁移数据）；否则为非空角色 ID 数组。
-- 只约束员工在 Skill 广场选用、会话选择 Skill 与执行前复核；Agent 固定引用不受限。
alter table skills add column visible_role_ids jsonb
  check (visible_role_ids is null
    or (jsonb_typeof(visible_role_ids) = 'array' and jsonb_array_length(visible_role_ids) > 0));
