#!/bin/bash
# Pack the extension into keyhop-<version>.xpi (a zip with manifest.json at the root).
set -euo pipefail
cd "$(dirname "$0")"
version=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
out="keyhop-${version}.xpi"
rm -f "$out"
python3 - "$out" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.write("manifest.json")
    for n in ("background.js", "content.js", "options.html", "options.js"):
        z.write(f"src/{n}")
PY
echo "built $out"
unzip -l "$out" | tail -8
