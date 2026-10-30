"""Write a synthetic workbook for package checks. Never use real responses in CI."""
import sys
from openpyxl import Workbook

book = Workbook()
sheet = book.active
sheet.append(["ID", "Recommend this product", "Written answer"])
for i in range(40):
    sheet.append([str(i), 9, f"Useful for task {i}"])
book.save(sys.argv[1])
