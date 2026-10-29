"""PlanLab <-> TotalSegmentator bridge (run with PlanLab's private Python environment).

  planlab_seg.py --download                    download the model weights used by PlanLab
  planlab_seg.py <ct.nii> <out dir> <options>  segment; options = JSON {"fast": bool, "roi": [class names]}

Writes <out dir>/labels.bin (uint8 label per voxel, same voxel order as the input: x fastest) and labels.json
(label id -> TotalSegmentator class name).
"""
import json
import os
import sys


def fetch_resumable(url, dest):
    """Downloads url to dest, resuming after dropped connections (slow or unreliable internet is common)."""
    import time
    import requests

    part = dest + ".part"
    total = None
    failures = 0
    last_print = 0.0
    while True:
        have = os.path.getsize(part) if os.path.exists(part) else 0
        if total is not None and have >= total:
            break
        try:
            headers = {"Range": f"bytes={have}-"} if have else {}
            with requests.get(url, headers=headers, stream=True, timeout=60, allow_redirects=True) as r:
                if r.status_code == 416:  # already complete
                    break
                r.raise_for_status()
                if r.status_code == 200 and have:  # server ignored the range: start again
                    have = 0
                    open(part, "wb").close()
                length = int(r.headers.get("Content-Length", 0))
                total = have + length if length else total
                t0, got = time.time(), 0
                with open(part, "ab") as f:
                    for chunk in r.iter_content(chunk_size=64 * 1024):
                        f.write(chunk)
                        got += len(chunk)
                        now = time.time()
                        if now - last_print > 2:
                            last_print = now
                            done = have + got
                            pct = 100 * done / total if total else 0
                            rate = got / max(now - t0, 1e-3) / 1000
                            print(f"{pct:3.0f}%| {done / 1e6:.1f} / {(total or 0) / 1e6:.0f} MB  {rate:.0f} kB/s", flush=True)
            failures = 0
            if total is None:
                break
        except Exception as e:  # dropped connection: wait and resume from where it stopped
            failures += 1
            if failures > 50:
                raise
            print(f"Connection interrupted ({type(e).__name__}); resuming in {min(60, 5 * failures)} s…", flush=True)
            time.sleep(min(60, 5 * failures))
    os.replace(part, dest)


def download():
    import zipfile
    from pathlib import Path
    from totalsegmentator.config import get_weights_dir
    from totalsegmentator.libs import TASK_ID_WEIGHTS_CONFIGS

    # 297 = "total" at 3 mm (fast); 298 = the 6 mm model used to crop the scan when only some organs are asked for.
    # The 1.5 mm models (291-295) download automatically the first time high resolution is used.
    base = "https://github.com/wasserth/TotalSegmentator/releases/download"
    config_dir = Path(get_weights_dir())
    for task_id in (297, 298):
        info = TASK_ID_WEIGHTS_CONFIGS[task_id]
        folder = info["foldername"]
        target = config_dir / Path(info.get("rel_path") or "") / folder
        if target.exists():
            print(f"PLANLAB: model {task_id} already present", flush=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        print(f"PLANLAB: downloading model {task_id} ({folder})", flush=True)
        zpath = str(target.parent / f"{folder}.zip")
        fetch_resumable(f"{base}/{info['version']}/{folder}.zip", zpath)
        print(f"PLANLAB: unpacking model {task_id}", flush=True)
        with zipfile.ZipFile(zpath) as z:
            z.extractall(target.parent)
        os.remove(zpath)
        if not target.exists():
            raise SystemExit(f"Model {task_id} did not unpack to {target}")


def segment(inp, outdir, opts):
    import nibabel as nib
    import numpy as np
    from totalsegmentator.map_to_binary import class_map
    from totalsegmentator.python_api import totalsegmentator

    img = nib.load(inp)
    roi = opts.get("roi") or None
    fast = bool(opts.get("fast", True))
    print(f"PLANLAB: segmenting {img.shape} ({'3 mm fast' if fast else '1.5 mm'}), {len(roi) if roi else 'all'} structures", flush=True)
    seg = totalsegmentator(img, None, ml=True, fast=fast, roi_subset=roi, device="cpu", nr_thr_saving=1)
    arr = np.asanyarray(seg.dataobj)
    if arr.shape[:3] != img.shape[:3]:
        raise SystemExit(f"Result grid {arr.shape} does not match the CT {img.shape}")
    with open(os.path.join(outdir, "labels.bin"), "wb") as f:
        f.write(arr.astype(np.uint8).tobytes(order="F"))
    with open(os.path.join(outdir, "labels.json"), "w") as f:
        json.dump({str(k): v for k, v in class_map["total"].items()}, f)
    print("PLANLAB: done", flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--download":
        download()
    else:
        segment(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))
