---
name: Office 文档（平台内置）
description: 平台内置的通用方法：生成或修改 Word（docx）、Excel（xlsx）、PowerPoint（pptx）文件，以及在 Office、PDF、Markdown、HTML 之间转换格式。目录中有更专门的文档类 Skill 时优先使用后者。
version: 1.0.0
allowed-tools: [read, glob, grep]
---

# Office 文档

适用于用户要求交付 Word、Excel、PPT 或 PDF 文件，或修改已有的此类成果。只要求文字回答时不必使用。

## 先确认工具链

执行说明中列出了本次执行环境实际可用的工具（如 `python3` 及 python-docx、openpyxl、python-pptx、pandas，`pandoc`，LibreOffice `soffice`）。先据此选择方法，不要假设未列出的工具存在，也不要尝试安装依赖（环境断网）。

## 生成方法

- **Word：** 用 python-docx 生成，标题用内置标题样式（便于目录与导航），正文段落、列表、表格分别使用对应结构，不用空格或空行排版。内容主要是文字时，也可以先写 Markdown 再用 `pandoc` 转为 docx。
- **Excel：** 用 openpyxl（数据处理可配合 pandas）生成。第一行为表头并冻结首行，设置合适列宽和数字格式（金额、百分比、日期）；需要计算的单元格可写普通公式（如 `=SUM(B2:B20)`）。不要写宏、外部工作簿链接、DDE 或 `WEBSERVICE` 等取远程数据的公式。
- **PowerPoint：** 用 python-pptx 生成。每页一个要点，标题简短，正文不超过 6 行；数据用表格或简单图表；不要嵌入音视频或外部链接对象。
- **PDF 与格式转换：** 用 `soffice --headless --convert-to pdf --outdir output <文件>` 把 docx、xlsx、pptx 转为 PDF；Markdown、HTML 与 docx 之间可用 `pandoc` 转换。
- **修改已有成果：** 原始文件在 `input/original/` 下（只读）。读取原件，修改后把完整文件写到 `output/<原文件名>`，不要另起新名字，平台会登记为该成果的下一个版本。

脚本写在命令里直接运行即可（例如 `python3 - <<'EOF' … EOF`），不要把脚本文件留在 `output/` 中。

## 内容与格式

- 中文内容使用通用字体（如“微软雅黑”“宋体”或保持默认），不依赖特殊字体。
- 文件名用有意义的中文或英文名称，扩展名与实际格式一致。
- 数据先算准再写入；来自用户文件的结论保留出处（方法见文件分析内置 Skill）。

## 完成前自检

- 用对应的库重新打开生成的文件（如 `Document(path)`、`load_workbook(path)`、`Presentation(path)`），确认能正常读取、页数或工作表符合预期。
- 确认文件写在 `output/` 顶层，单个不超过 20 MB，没有残留的临时文件。
- 工具链缺少所需组件、或不能运行命令时，改为当前可用的格式（例如 Markdown 或 CSV），并在回答中说明原因和替代方案。
