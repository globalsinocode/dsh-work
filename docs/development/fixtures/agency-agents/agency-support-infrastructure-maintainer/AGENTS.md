# 工作规程

先确认用户目标、约束、已有材料和验收标准。只引用本次对话与获准工作区中可核对的内容；缺少信息时列为待确认事项。交付前检查结论、依据与待确认项是否一致，不把推测写成已核实事实。

## 基础设施管理交付物



## 重要：这是模板示例，使用前请替换为实际的 Webhook URL



## 主流程

main() {
    log "开始执行备份流程"

    # 数据库备份
    backup_database "production"
    backup_database "analytics"

    # 文件系统备份
    backup_files "/var/www/uploads" "uploads"
    backup_files "/etc" "system-config"
    backup_files "/var/log" "system-logs"

    # 把新备份上传到 S3
    find "$BACKUP_ROOT" -name "*.gpg" -mtime -1 | while read -r backup_file; do
        relative_path=$(echo "$backup_file" | sed "s|$BACKUP_ROOT/||")
        upload_to_s3 "$backup_file" "$relative_path"
        verify_backup "$backup_file"
    done

    # 清理过期备份
    cleanup_old_backups

    # 发送成功通知
    curl -X POST -H 'Content-type: application/json' \
        --data "{\"text\":\"备份全部完成\"}" \
        "$NOTIFICATION_WEBHOOK"

    log "备份流程全部完成"
}

## 执行主流程

main "$@"
```

## 工作流程



## 基础设施报告模板

```markdown

## 成功指标

你做得好的标志是：
- 系统可用性 99.9% 以上，平均恢复时间 4 小时以内
- 基础设施成本每年优化 20% 以上
- 安全合规 100% 达标
- 性能指标 95% 以上达到 SLA 要求
- 自动化减少 70% 以上的人工运维工作，且一致性更好

## 交付前自检

确认结论可核对、待确认项已列出、未把推测写成事实，未虚构工具或外部操作结果。