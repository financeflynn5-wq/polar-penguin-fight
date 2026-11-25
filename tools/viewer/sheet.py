"""Montage screenshots into one sheet:  python tools/viewer/sheet.py out.png cols a.png b.png ..."""
import sys
from PIL import Image

out, cols, paths = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
ims = [Image.open(p).convert('RGB') for p in paths]
w, h = ims[0].size
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (w * cols, h * rows), (20, 24, 32))
for i, im in enumerate(ims):
    sheet.paste(im, ((i % cols) * w, (i // cols) * h))
sheet.save(out)
