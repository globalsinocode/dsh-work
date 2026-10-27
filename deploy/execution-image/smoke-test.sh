#!/usr/bin/env bash
# Checks a locally present execution image under the same posture as a real execution container
# (server/src/modules/runtime/docker-execution-backend.ts): no network, read-only root, no
# capabilities, non-root uid without a passwd entry, tmpfs /tmp and HOME. Never pulls.
#
# Usage: bash deploy/execution-image/smoke-test.sh <image>
set -euo pipefail

image=${1:?usage: smoke-test.sh <image>}
user=65534:65534

checks=$(cat <<'CHECKS'
set -euo pipefail
step() { printf '== %s\n' "$1"; }

step 'toolchain'
bash --version | head -n 1
rg --version | head -n 1 | grep -E '^ripgrep 15\.0\.0( |$)'
soffice --version
pdftoppm -v 2>&1 | head -n 1
pandoc --version | head -n 1
python -I -c 'import pandas, openpyxl, docx, pptx; print("pandas", pandas.__version__, "openpyxl", openpyxl.__version__)'

step 'CJK fonts'
fc-list :lang=zh family | grep -i 'noto'

step 'office conversion'
mkdir -p /tmp/smoke/out
cd /tmp/smoke
python -I - <<'PY'
import docx, openpyxl, pptx
document = docx.Document()
document.add_heading('季度经营报告', level=1)
document.add_paragraph('华东区收入同比增长 12%。')
document.save('report.docx')
workbook = openpyxl.Workbook()
workbook.active.append(['区域', '收入'])
workbook.active.append(['华东', 1200])
workbook.save('revenue.xlsx')
deck = pptx.Presentation()
slide = deck.slides.add_slide(deck.slide_layouts[1])
slide.shapes.title.text = '经营概览'
deck.save('overview.pptx')
PY
soffice --headless --convert-to pdf --outdir out report.docx revenue.xlsx overview.pptx
pdftotext out/report.pdf - | grep '季度经营报告'
pdftotext out/revenue.pdf - | grep '华东'
pdftotext out/overview.pdf - | grep '经营概览'
pdffonts out/report.pdf | grep -i 'noto'
pdftoppm -png -r 50 -singlefile out/report.pdf out/report
test -s out/report.png

step 'glob and grep'
rg --files --sort=modified /tmp/smoke | grep 'report.docx'
CHECKS
)

docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --security-opt seccomp=builtin --init \
  --memory 1g --cpus 2 --pids-limit 256 --ulimit fsize=268435456:268435456 \
  --user "${user}" \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
  --tmpfs "/home/exec:rw,nosuid,nodev,size=256m,uid=${user%%:*},gid=${user##*:},mode=0700" \
  -e LANG=C.UTF-8 -e HOME=/home/exec -e TMPDIR=/tmp \
  -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --entrypoint bash "${image}" -c "${checks}"

echo "execution image smoke test passed: ${image}"
