"""Include license notices for the bundled interpreter and Python libraries."""
import importlib.metadata
from pathlib import Path
import shutil
import sys
import sysconfig

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
license_paths = [Path(sysconfig.get_path("stdlib")) / "LICENSE.txt", Path(sys.base_prefix) / "LICENSE.txt"]
python_license = next((path for path in license_paths if path.is_file()), None)
if python_license is None:
    raise FileNotFoundError("Cannot locate the Python license.")
shutil.copyfile(python_license, root / "Python.txt")
names = ["pandas", "numpy", "openpyxl", "et_xmlfile", "python-dateutil", "pytz", "tzdata", "six"]
if sys.platform == "linux":
    names.append("dbus-next")
for name in names:
    package = importlib.metadata.distribution(name)
    target = root / name
    target.mkdir()
    (target / "METADATA.txt").write_text(package.read_text("METADATA"), encoding="utf-8")
    for file in package.files or []:
        if any(part.lower().startswith(("license", "copying", "notice")) for part in file.parts):
            output = target / str(file)
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(package.locate_file(file), output)
