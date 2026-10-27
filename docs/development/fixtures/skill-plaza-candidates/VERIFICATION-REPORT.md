# Skill 广场候选校验报告

- **批次**：`batch-01`
- **生成时间**：2026-10-27T01:12:45.796Z
- **期望包数**：99
- **ZIP 数**：99
- **parse 失败/缺失**：0

## 结论

全部 ZIP 已通过 `parseSkillPackage` 结构校验。本批次 **未发布**（`PUBLISH-ALLOWLIST.json` 中 `publish` 均为 `false`）。

## 试运行说明

- 含 `.py` 的文档技能需在受控环境执行 `python_execute` 试运行后再考虑发布。
- KWP 技能若引用 Slack/日历等连接器，仅作写作流程使用，不宣称已接通外部系统。

## 明细

| id | parse | compatibility | files | blockers |
|----|-------|---------------|-------|----------|
| plaza-sp-writing-plans | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-sp-executing-plans | ok | compatible | 8 | batch_01_manual_signoff |
| plaza-sp-systematic-debugging | ok | compatible | 10 | batch_01_manual_signoff |
| plaza-sp-test-driven-development | ok | compatible | 3 | batch_01_manual_signoff |
| plaza-sp-requesting-code-review | ok | compatible | 3 | batch_01_manual_signoff |
| plaza-sp-receiving-code-review | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-sp-verification-before-completion | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-sp-finishing-a-development-branch | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-anth-pdf | ok | needs_review | 13 | needs_review, python_execute, batch_01_manual_signoff |
| plaza-anth-pptx | ok | needs_review | 18 | needs_review, python_execute, batch_01_manual_signoff |
| plaza-anth-xlsx | ok | needs_review | 15 | needs_review, python_execute, batch_01_manual_signoff |
| plaza-anth-doc-coauthoring | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-anth-internal-comms | ok | compatible | 7 | batch_01_manual_signoff |
| plaza-kwp-finance-audit-support | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-finance-close-management | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-finance-financial-statements | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-finance-journal-entry | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-finance-journal-entry-prep | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-finance-reconciliation | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-finance-sox-testing | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-finance-variance-analysis | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-legal-brief | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-legal-compliance-check | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-legal-legal-response | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-legal-legal-risk-assessment | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-legal-meeting-briefing | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-legal-review-contract | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-legal-signature-request | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-legal-triage-nda | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-legal-vendor-check | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-product-management-competitive-brief | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-product-management-metrics-review | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-product-management-product-brainstorming | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-product-management-roadmap-update | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-product-management-sprint-planning | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-product-management-stakeholder-update | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-product-management-synthesize-research | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-product-management-write-spec | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-operations-capacity-plan | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-operations-change-request | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-operations-compliance-tracking | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-operations-process-doc | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-operations-process-optimization | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-operations-risk-assessment | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-operations-runbook | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-operations-status-report | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-operations-vendor-review | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-account-context | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-account-plan | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-account-research | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-account-tiering | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-call-prep | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-call-summary | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-close-plan | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-competitive-intelligence | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-create-an-asset | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-crm-hygiene-check | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-customer-health | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-customer-voice | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-daily-briefing | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-deal-advance-gap | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-deal-review | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-deal-signals | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-deal-slip-scenario | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-draft-outreach | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-end-of-day | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-expansion-whitespace | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-forecast | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-handle-objection | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-inbox-sweep | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-lead-triage | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-log-activity | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-pipeline-review | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-renewal-radar | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-rep-context | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-setup | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-stakeholder-map | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-team-pipeline | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-update-opportunity | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-weekly-wrap | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-sales-win-loss-review | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-customer-support-customer-escalation | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-customer-support-customer-research | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-customer-support-draft-response | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-customer-support-kb-article | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-customer-support-ticket-triage | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-productivity-memory-management | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-productivity-start | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-productivity-task-management | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-productivity-update | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-human-resources-comp-analysis | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-human-resources-draft-offer | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-human-resources-interview-prep | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-human-resources-onboarding | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-human-resources-org-planning | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-human-resources-people-report | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-human-resources-performance-review | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-human-resources-policy-lookup | ok | compatible | 2 | batch_01_manual_signoff |
| plaza-kwp-human-resources-recruiting-pipeline | ok | compatible | 2 | batch_01_manual_signoff |

