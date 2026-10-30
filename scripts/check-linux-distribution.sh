#!/usr/bin/env bash
set -euo pipefail
. /etc/os-release
if [[ "$ID" == fedora ]]; then
    dnf install -y python3 python3-pip dbus-daemon libstdc++
else
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv dbus-daemon libstdc++6
fi
python3 -m venv /tmp/cv-portal-test
/tmp/cv-portal-test/bin/pip install --quiet dbus-next==0.2.3 openpyxl==3.1.5
/tmp/cv-portal-test/bin/python scripts/make-test-export.py /tmp/cv-package.xlsx
CUSTOMER_VOICE_TEST_XLSX=/tmp/cv-package.xlsx node tests/package-check.mjs
dbus-run-session -- /tmp/cv-portal-test/bin/python tests/linux-portal-check.py
printf 'Package compatibility passed: %s %s\n' "$ID" "$VERSION_ID"
