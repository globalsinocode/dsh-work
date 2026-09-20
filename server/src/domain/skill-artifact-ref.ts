// 唯一 artifact_ref 规则（B-02）：包名段首尾必须为字母数字，拒绝旧版生成器遗留的
// 首尾符号形态及 . / .. 遍历段。Schema（runtime-manifest.schema.json）、Manifest
// 编译器与 FileSystemSkillArtifactStore 读写同口径；越界防护由存储层 resolve
// 边界检查承担。contracts 静态检查固定 Schema 中的等价 pattern。
export const SKILL_ARTIFACT_REF_PATTERN = /^packages\/(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]{0,62}[A-Za-z0-9])\/[a-f0-9]{64}$/
