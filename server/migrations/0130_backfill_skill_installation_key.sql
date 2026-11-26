-- 为缺少安装名称的 Skill 补写 installation_key（docs/development/feature-rules.md 5.3“升级”）。
--
-- 安装按 installation_key 识别已有 Skill。0035 只为当时已有安装包的 Skill 回填过一次；
-- 此后经已删除的文本创建接口写入的 Skill 与 0006 的种子 Skill 都没有这一列，
-- 安装同名包会新建一个同名 Skill，而不是生成它的下一版本。
--
-- 规则（与 0035 一致：规范化名称 = 去首尾空白并转小写，每个名称只给一行）：
-- 1. 员工提交审核中建的 Skill 不补：通过审核前不占用名称，通过时由审核写入（skill-submission-review-service）。
-- 2. 名称已被其他 Skill 占用的不补，保持唯一索引 skills_by_installation_key 成立。
-- 3. 同名的多行只补一行：未停用的优先，再取最早创建的版本所在的那一行；其余保持为空，安装不会落到它们上。
with candidates as (
  select
    s.tenant_id,
    s.id,
    lower(btrim(s.name)) as installation_key,
    row_number() over (
      partition by s.tenant_id, lower(btrim(s.name))
      order by
        (s.status = 'disabled'),
        (select min(sv.created_at) from skill_versions sv where sv.tenant_id = s.tenant_id and sv.skill_id = s.id) nulls last,
        s.updated_at,
        s.id
    ) as ordinal
  from skills s
  where s.installation_key is null
    and not exists (
      select 1 from skill_submissions submission
       where submission.tenant_id = s.tenant_id and submission.skill_id = s.id
    )
    and not exists (
      select 1 from skills taken
       where taken.tenant_id = s.tenant_id and taken.installation_key = lower(btrim(s.name))
    )
)
update skills s
   set installation_key = candidates.installation_key
  from candidates
 where s.tenant_id = candidates.tenant_id
   and s.id = candidates.id
   and candidates.ordinal = 1;
