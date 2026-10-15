"""Read only allowlisted relationship entries, never extract an entire X archive."""
import json
import os
import re
import stat
import sys
import zipfile

LIMIT = 100 * 1024 * 1024
pattern = re.compile(r'^(following|follower)(?:-part\d+)?\.(?:js|json)$', re.I)
try:
    # O_NOFOLLOW rejects a ZIP symlink too; all payloads remain in memory.
    fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as file, zipfile.ZipFile(file) as archive:
        if len(archive.infolist()) > 200_000:
            raise ValueError('ZIP 中的文件数量过多。')
        groups = {}
        for info in archive.infolist():
            parts = info.filename.split('/')
            if any(part in ('.', '..') for part in parts) or info.filename.startswith('/') or '\\' in info.filename:
                continue
            if not pattern.fullmatch(parts[-1]):
                continue
            if stat.S_ISLNK(info.external_attr >> 16) or info.flag_bits & 1:
                raise ValueError('名单文件不能是符号链接或加密文件。')
            groups.setdefault('/'.join(parts[:-1]), []).append(info)
        if not groups:
            raise ValueError('ZIP 中没有 following.js 和 follower.js 名单。')
        if len(groups) != 1:
            raise ValueError('ZIP 中发现多组名单，请分别解压到不同文件夹后选择。')
        entries = next(iter(groups.values()))
        if sum(info.file_size for info in entries) > LIMIT:
            raise ValueError('两份名单文件合计不能超过 100 MB。')
        result = []
        for info in entries:
            with archive.open(info) as source:
                raw = source.read(min(info.file_size, LIMIT) + 1)
            if len(raw) != info.file_size or len(raw) > LIMIT:
                raise ValueError('ZIP 名单大小异常。')
            result.append({'name': info.filename.split('/')[-1], 'size': len(raw), 'text': raw.decode('utf-8-sig')})
        json.dump({'files': result}, sys.stdout, ensure_ascii=False)
except Exception as error:
    json.dump({'error': str(error) if isinstance(error, ValueError) else '无法读取 ZIP 存档，请确认下载完整且未加密。'}, sys.stdout, ensure_ascii=False)
    sys.exit(1)
