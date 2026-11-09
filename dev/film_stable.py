"""For each desk segment of the film plan, find how long the cropped picture stays like the frame at its mark.

Exit 1 and print each clip that changes before its end.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
W, H, FPS = 160, 90, 4


def frames(start, seconds, c, video):
    vf = (f"crop=trunc(iw*{c['w']}):trunc(ih*{c['h']}):trunc(iw*{c['x']}):trunc(ih*{c['y']}),"
          f"scale={W}:{H},fps={FPS},format=gray")
    out = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{start:.3f}', '-t', f'{seconds:.3f}', '-i', str(video),
                          '-vf', vf, '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(out, np.uint8).reshape(-1, H, W).astype(float)


def check_stability(timeline_path, marks_path, video_path):
    tl = json.loads(Path(timeline_path).read_text(encoding='utf-8'))
    marks = json.loads(Path(marks_path).read_text(encoding='utf-8'))

    changing = []
    for clip in tl['clips']:
        if 'crop' not in clip or clip.get('layout') == 'phone':
            continue
        name = clip['mark']
        if name.endswith('-click'):
            continue
        length = clip['out'] - clip['in']
        f = frames(clip['in'], length, clip['crop'], video_path)
        ref_i = min(len(f) - 1, max(0, int((marks['desk'][name][0] + 0.2 - clip['in']) * FPS)))
        ref = f[ref_i]
        diffs = [float(np.mean(np.abs(x - ref))) for x in f]
        still = length
        for i in range(ref_i, len(diffs)):
            if diffs[i] > 12:
                still = i / FPS
                break
        changed = still < length - 0.3
        flag = '  <-- changes' if changed else ''
        print(f"{name:20s} film {clip['start']:7.2f} len {length:5.2f} still until {still:5.2f}{flag}  "
              f"max diff {max(diffs[ref_i:]):5.1f}")
        if changed:
            changing.append((name, clip['start'], length, still))

    if changing:
        print(f"\n{len(changing)} clips change before end:")
        for name, start, length, still in changing:
            print(f"  {name:20s} film {start:7.2f} len {length:5.2f} still until {still:5.2f}")
        return 1
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeline', type=Path, default=ROOT / 'docs/video/roamreprise-r2.timeline.json')
    parser.add_argument('--marks', type=Path, default=ROOT / 'docs/video/roamreprise-r2.marks.json')
    parser.add_argument('--video', type=Path, default=Path('A:/Projects/showcase-kit/public/media/roamreprise-r2/desk.webm'))
    args = parser.parse_args(argv)
    return check_stability(args.timeline, args.marks, args.video)


if __name__ == '__main__':
    sys.exit(main())
