#!/usr/bin/env python3
"""Stamp every internal file reference with a content hash (?v=xxxx) so browsers like Bluefy
can't keep running an old cached copy after an update. Run before each commit: npm run bump"""
import hashlib, pathlib, re
root = pathlib.Path(__file__).resolve().parent.parent
files = sorted(list((root / 'js').glob('*.js')) + [root / 'style.css'])
strip = lambda t: re.sub(r'\?v=[0-9a-f]+', '', t)
h = hashlib.sha1(''.join(strip(f.read_text()) for f in files).encode()).hexdigest()[:8]
pat = [(r"(from '\./\w+\.js)(\?v=[0-9a-f]+)?'", r"\1?v=%s'" % h),
       (r'(src="js/\w+\.js)(\?v=[0-9a-f]+)?"', r'\1?v=%s"' % h),
       (r'(href="style\.css)(\?v=[0-9a-f]+)?"', r'\1?v=%s"' % h)]
for f in list((root / 'js').glob('*.js')) + [root / 'index.html', root / 'preview.html']:
    t = f.read_text(); n = t
    for a, b in pat: n = re.sub(a, b, n)
    if n != t: f.write_text(n)
print('version', h)
