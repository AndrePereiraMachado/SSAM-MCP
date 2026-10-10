#!/usr/bin/env python3
"""Reads an OutSystems Studio installer (NSIS 3, solid LZMA) WITHOUT running it, with the Python standard library only.

  nsis_extract.py list    <installer.exe> [--json <out.json>] [--hashes]
  nsis_extract.py extract <installer.exe> <outdir> --marker <file> [--only <list.txt>]

list     prints every file the installer would write ($INSTDIR\\..., $PLUGINSDIR\\...), with size and sha256 when --hashes.
extract  writes the files of the Studio folder: the $INSTDIR subfolder that holds --marker (ServiceStudio.Framework.dll
         for Service Studio 11, OutSystems.ModelAPILoader.dll for ODC Studio). With --only, just the paths of that list
         (relative to the Studio folder, one per line, # comments); a listed path the installer does not carry stops
         the extraction (exit 2) and names it.

How it reads: the NSIS first header (0xDEADBEEF "NullsoftInst") is followed by one LZMA stream (5 property bytes, no end
marker). Decompressed, it is the install header (its size first) and then the data blocks (4-byte size + bytes). The
header's entry table is replayed linearly: SetOutPath (EW_CREATEDIR with parm1=1) sets $OUTDIR, File /r assigns
$_OUTDIR (EW_ASSIGNVAR 31), and every File is an EW_EXTRACTFILE whose parm2 is the offset of its data block.
Proven on Windows (2026-10-07): ServiceStudio-11.55.91.65258.exe gives the 1138 files of the installed Service Studio
11.55.91 folder byte for byte (sha256), ODCStudio-1.7.23.10682.exe the 975 files of the ODC Studio folder.
"""
import hashlib
import json
import lzma
import os
import struct
import sys

EW_CREATEDIR, EW_EXTRACTFILE, EW_ASSIGNVAR = 11, 20, 25
VAR_INSTDIR, VAR_OUTDIR, VAR_PLUGINSDIR, VAR__OUTDIR = 21, 22, 26, 31
NAMES = {20: "$CMDLINE", 21: "$INSTDIR", 22: "$OUTDIR", 23: "$EXEDIR", 24: "$LANGUAGE", 25: "$TEMP",
         26: "$PLUGINSDIR", 27: "$EXEPATH", 28: "$EXEFILE", 29: "$HWNDPARENT", 30: "$_CLICK", 31: "$_OUTDIR"}
SIGNATURE = b"\xef\xbe\xad\xdeNullsoftInst"
CHUNK = 1 << 22


class Stream:
    """Sequential reader over the decompressed solid stream."""

    def __init__(self, path):
        self.f = open(path, "rb")
        head = self.f.read(1 << 20)
        i = head.find(SIGNATURE)
        while i < 0:
            more = self.f.read(1 << 20)
            if not more:
                raise ValueError("not an NSIS installer: " + path)
            head += more
            i = head.find(SIGNATURE)
        first = i - 4
        self.header_size, self.archive_size = struct.unpack_from("<ii", head, first + 20)
        self.f.seek(first + 28)
        props = self.f.read(5)
        if props[0] >= 9 * 5 * 5:
            raise ValueError("not a solid LZMA NSIS stream (properties %s)" % props.hex())
        p = props[0]
        self.dec = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[{
            "id": lzma.FILTER_LZMA1, "dict_size": struct.unpack("<I", props[1:5])[0],
            "lc": p % 9, "lp": (p // 9) % 5, "pb": p // 45}])
        self.remaining = self.archive_size - 5
        self.buf = bytearray()

    def _fill(self, n):
        while len(self.buf) < n:
            if not self.dec.needs_input:
                self.buf += self.dec.decompress(b"", max_length=CHUNK)
                continue
            if self.remaining <= 0:
                raise EOFError("the installer stream ended early")
            chunk = self.f.read(min(CHUNK, self.remaining))
            if not chunk:
                raise EOFError("the installer file is truncated")
            self.remaining -= len(chunk)
            self.buf += self.dec.decompress(chunk, max_length=CHUNK)

    def read(self, n):
        self._fill(n)
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def copy(self, n, sink):
        while n > 0:
            if not self.buf:
                self._fill(1)
            take = min(n, len(self.buf))
            sink(bytes(self.buf[:take]))
            del self.buf[:take]
            n -= take


def parse_header(h):
    blocks = [struct.unpack_from("<ii", h, 4 + 8 * k) for k in range(8)]
    entries_at, entries = blocks[2]
    strings_at, langs_at = blocks[3][0], blocks[4][0]
    table = h[strings_at:langs_at]
    unicode = table[:2] == b"\x00\x00" and len(table) > 3 and table[3] == 0
    values = {}

    def code(n, kind):
        if kind == "var":
            return values.get(n) or NAMES.get(n, "$R%d" % (n - 10) if 10 <= n < 20 else "$%d" % n)
        return "$SHELL(%d)" % n if kind == "shell" else "$(LANG%d)" % n

    def string(offset):
        out = []
        if unicode:
            i = strings_at + offset * 2
            while True:
                c = struct.unpack_from("<H", h, i)[0]
                i += 2
                if c == 0:
                    break
                if c in (1, 2, 3):  # LANG, SHELL, VAR, then one WCHAR holding two 7-bit halves
                    w = struct.unpack_from("<H", h, i)[0]
                    i += 2
                    out.append(code((w & 0x7F) | (((w >> 8) & 0x7F) << 7), {1: "lang", 2: "shell", 3: "var"}[c]))
                    continue
                if c == 4:  # SKIP: the next WCHAR is literal
                    c = struct.unpack_from("<H", h, i)[0]
                    i += 2
                out.append(chr(c))
        else:
            i = strings_at + offset
            while h[i] != 0:
                c = h[i]
                i += 1
                if c in (253, 254, 255):  # VAR, SHELL, LANG, then two bytes holding two 7-bit halves
                    out.append(code((h[i] & 0x7F) | ((h[i + 1] & 0x7F) << 7), {253: "var", 254: "shell", 255: "lang"}[c]))
                    i += 2
                    continue
                if c == 252:  # SKIP
                    c = h[i]
                    i += 1
                out.append(chr(c))
        return "".join(out)

    files = []
    for k in range(entries):
        which, *p = struct.unpack_from("<7i", h, entries_at + 28 * k)
        if which == EW_CREATEDIR and p[1] != 0:
            values[VAR_OUTDIR] = string(p[0])
        elif which == EW_ASSIGNVAR and p[0] in (VAR_OUTDIR, VAR__OUTDIR):
            values[p[0]] = string(p[1])
        elif which == EW_EXTRACTFILE:
            name = string(p[1])
            if not name.startswith("$"):
                name = values.get(VAR_OUTDIR, "").rstrip("\\") + "\\" + name
            files.append({"path": name, "offset": p[2]})
    return {"unicode": unicode, "entries": entries, "files": files}


def open_installer(path):
    s = Stream(path)
    size = struct.unpack("<I", s.read(4))[0]
    return s, parse_header(s.read(size))


def walk(s, wanted, on_block):
    """Streams the data blocks in order up to the last wanted offset; on_block consumes exactly the block."""
    pos, last = 0, max(wanted) if wanted else -1
    while pos <= last:
        size = struct.unpack("<I", s.read(4))[0]
        if size & 0x80000000:
            raise ValueError("compressed block inside a solid stream")
        if pos in wanted:
            on_block(pos, size, s)
        else:
            s.copy(size, lambda b: None)
        pos += 4 + size


def option(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("list", "extract"):
        sys.exit(__doc__)
    cmd, installer = sys.argv[1], sys.argv[2]
    s, info = open_installer(installer)
    files = info["files"]
    if cmd == "list":
        if "--hashes" in sys.argv:
            facts = {}

            def measure(offset, size, st):
                digest = hashlib.sha256()
                st.copy(size, digest.update)
                facts[offset] = (size, digest.hexdigest())
            walk(s, {f["offset"] for f in files}, measure)
            for f in files:
                f["size"], f["sha256"] = facts[f["offset"]]
        out = option("--json")
        if out:
            with open(out, "w", encoding="utf-8") as fp:
                json.dump({"installer": os.path.basename(installer), "entries": info["entries"], "files": files}, fp, indent=1)
        else:
            for f in files:
                print(f["path"] + ("\t%d\t%s" % (f["size"], f["sha256"]) if "sha256" in f else ""))
        print("%s: %d entries, %d files" % (os.path.basename(installer), info["entries"], len(files)), file=sys.stderr)
        return
    outdir, marker = sys.argv[3], option("--marker")
    if not marker:
        sys.exit("extract needs --marker <file of the Studio folder>")
    roots = sorted({f["path"][:-len(marker)] for f in files
                    if f["path"].startswith("$INSTDIR\\") and f["path"].lower().endswith("\\" + marker.lower())}, key=len)
    if not roots:
        sys.exit("%s: no $INSTDIR file named %s" % (installer, marker))
    root = roots[0]
    inside = {}
    for f in files:
        if f["path"].startswith(root):
            inside.setdefault(f["path"][len(root):].replace("\\", "/").lower(), f)
    only = None
    if option("--only"):
        with open(option("--only"), encoding="utf-8") as fp:
            only = [line.strip() for line in fp if line.strip() and not line.lstrip().startswith("#")]
        missing = [p for p in only if p.lower() not in inside]
        if missing:
            print("the installer does not carry %d listed file(s): %s" % (len(missing), ", ".join(missing)), file=sys.stderr)
            sys.exit(2)
    chosen = only if only is not None else [inside[k]["path"][len(root):].replace("\\", "/") for k in sorted(inside)]
    by_offset = {}
    for rel in chosen:
        by_offset.setdefault(inside[rel.lower()]["offset"], []).append(rel)

    def write(offset, size, st):
        handles = []
        for rel in by_offset[offset]:
            dst = os.path.join(outdir, *rel.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            handles.append(open(dst, "wb"))
        st.copy(size, lambda b: [h.write(b) for h in handles])
        for h in handles:
            h.close()
    walk(s, set(by_offset), write)
    print("%s: %d file(s) of %s into %s" % (os.path.basename(installer), len(chosen), root.rstrip("\\"), outdir))


if __name__ == "__main__":
    main()
