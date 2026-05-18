import subprocess

files = [
    ('upstream_master:index.ts', 'index.ts'),
    ('upstream_master:src/chunker.ts', 'src/chunker.ts'),
    ('upstream_master:package.json', 'package.json'),
    ('upstream_master:package-lock.json', 'package-lock.json'),
]

for src, dst in files:
    content = subprocess.check_output(['git', 'show', src], text=True, encoding='utf-8', errors='replace')
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'Restored {dst} ({len(content)} chars)')