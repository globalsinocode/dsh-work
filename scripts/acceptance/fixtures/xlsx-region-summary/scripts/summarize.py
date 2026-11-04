"""按分组列汇总 xlsx/csv 表格。

用法：summarize.py <原始文件绝对路径> [--group 列名] [--value 列名] [--name 输出文件名]
不传文件时用内置小样例自检并以 0 退出（严格试运行不提供业务输入）；
传了文件却找不到或读不了时以非 0 退出，不改跑样例。
"""

import argparse
import csv
import os
import sys
from collections import OrderedDict
from decimal import Decimal, InvalidOperation

from openpyxl import Workbook, load_workbook

SAMPLE = [["区域", "产品", "金额"], ["华东", "A", 1200], ["华南", "A", 800], ["华东", "B", 300]]


def read_rows(path):
    suffix = os.path.splitext(path)[1].lower()
    if suffix in (".xlsx", ".xlsm"):
        sheet = load_workbook(path, read_only=True, data_only=True).worksheets[0]
        return [list(row) for row in sheet.iter_rows(values_only=True)]
    if suffix in (".csv", ".txt"):
        with open(path, encoding="utf-8-sig", newline="") as handle:
            return [row for row in csv.reader(handle)]
    raise ValueError(f"不支持的文件类型：{suffix or '无扩展名'}，只支持 xlsx 或 csv")


def to_number(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    try:
        return Decimal(str(value).replace(",", "").strip())
    except InvalidOperation:
        return None


def summarize(rows, group, value):
    rows = [row for row in rows if any(cell not in (None, "") for cell in row)]
    if not rows:
        raise ValueError("表格是空的")
    header = [str(cell).strip() if cell is not None else "" for cell in rows[0]]
    missing = [name for name in (group, value) if name not in header]
    if missing:
        raise ValueError(f"找不到列：{'、'.join(missing)}。现有表头：{'、'.join(h for h in header if h)}")
    g, v = header.index(group), header.index(value)
    totals, counts, skipped = OrderedDict(), {}, 0
    for row in rows[1:]:
        key = row[g] if g < len(row) else None
        amount = to_number(row[v] if v < len(row) else None)
        if key in (None, "") or amount is None:
            skipped += 1
            continue
        key = str(key).strip()
        totals[key] = totals.get(key, Decimal(0)) + amount
        counts[key] = counts.get(key, 0) + 1
    if not totals:
        raise ValueError(f"“{value}”列没有可汇总的数值")
    return totals, counts, skipped


def plain(number):
    return int(number) if number == number.to_integral_value() else float(number)


def write_outputs(stem, group, value, totals, counts, skipped, note):
    out = os.environ["DSH_OUTPUT_DIR"]
    book = Workbook()
    sheet = book.active
    sheet.title = "汇总"
    sheet.append([group, f"{value}合计", "行数"])
    for key, total in totals.items():
        sheet.append([key, plain(total), counts[key]])
    sheet.append(["总计", plain(sum(totals.values())), sum(counts.values())])
    xlsx = os.path.join(out, f"{stem}-汇总.xlsx")
    book.save(xlsx)
    lines = [f"# {stem} 按{group}汇总{value}", ""]
    if note:
        lines += [f"> {note}", ""]
    lines += [f"| {group} | {value}合计 | 行数 |", "| --- | ---: | ---: |"]
    lines += [f"| {key} | {plain(total)} | {counts[key]} |" for key, total in totals.items()]
    lines += [f"| 总计 | {plain(sum(totals.values()))} | {sum(counts.values())} |", ""]
    if skipped:
        lines.append(f"跳过 {skipped} 行（分组或数值为空、数值无法识别）。")
    md = os.path.join(out, f"{stem}-汇总.md")
    with open(md, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    return [os.path.basename(xlsx), os.path.basename(md)]


def main():
    parser = argparse.ArgumentParser(description="按分组列汇总 xlsx/csv 表格")
    parser.add_argument("file", nargs="?", help="原始文件的绝对路径")
    parser.add_argument("--group", default="区域")
    parser.add_argument("--value", default="金额")
    parser.add_argument("--name", help="输出文件名（不含扩展名），默认取输入文件名；挂载路径只保留 ASCII 字符，建议传员工看到的原文件名")
    args = parser.parse_args()

    if args.file is None:
        rows, stem, note = SAMPLE, "自检样例", "自检结果，不是业务结果：没有传入文件，使用了内置样例。"
    else:
        if not os.path.isfile(args.file):
            print(f"找不到输入文件：{args.file}（请传入 input/original/ 下原始文件的绝对路径）", file=sys.stderr)
            return 2
        rows, stem, note = None, os.path.splitext(os.path.basename(args.file))[0], ""
        if args.name:
            stem = os.path.basename(args.name.strip()) or stem
        try:
            rows = read_rows(args.file)
        except Exception as error:  # 文件损坏或格式不对时给出可读原因
            print(f"读取失败：{error}", file=sys.stderr)
            return 3
    try:
        totals, counts, skipped = summarize(rows, args.group, args.value)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 4
    files = write_outputs(stem, args.group, args.value, totals, counts, skipped, note)
    if note:
        print(note)
    print(f"分组数：{len(totals)}；总计：{plain(sum(totals.values()))}；跳过：{skipped} 行")
    for key, total in totals.items():
        print(f"{key}\t{plain(total)}")
    print("生成文件：" + "、".join(files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
