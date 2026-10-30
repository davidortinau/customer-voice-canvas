"""Include license notices for the bundled interpreter and Python libraries."""
import importlib.metadata
from pathlib import Path
import shutil
import sys
import sysconfig

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
shutil.copyfile(Path(sysconfig.get_path("stdlib")) / "LICENSE.txt", root / "Python.txt")
for name in ["pandas", "numpy", "openpyxl", "et_xmlfile", "python-dateutil", "pytz", "tzdata", "six"]:
    package = importlib.metadata.distribution(name)
    target = root / name
    target.mkdir()
    (target / "METADATA.txt").write_text(package.read_text("METADATA"), encoding="utf-8")
    for file in package.files or []:
        if any(part.lower().startswith(("license", "copying", "notice")) for part in file.parts):
            output = target / str(file)
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(package.locate_file(file), output)
