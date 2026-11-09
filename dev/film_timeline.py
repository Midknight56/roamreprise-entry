"""Build the 170 second film after copying the real recordings into the kit.

Defaults write the kit timeline and its docs/video copy. Optional path arguments
allow an offline dry run entirely in a temporary directory. No network access.
"""
import argparse
import json
import math
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIT = Path('A:/Projects/showcase-kit')
MEDIA = 'media/roamreprise/'
LENGTHS = [7, 10, 13, 15, 15, 8, 12, 25, 15, 12, 13, 10, 8, 7]
ANCHORS = ['b1-idle', 'b2-map', 'b3-why', 'b4-quote-click', 'b5-quote-click',
           'b6-tooltip', 'b7-cancel-click', 'b8-repair', 'b9-use-click',
           'b10-confirm-click', 'b11-cancel-click', 'b12-receipts', 'phone-start', 'b14-ids']
# Adjust only after reviewing real footage. Source times always remain real time.
OFFSETS = {n: -1.0 for n in range(1, 15)}


def probe(path, executable='ffprobe'):
    result = subprocess.run([str(executable), '-v', 'error', '-show_entries', 'format=duration',
                             '-of', 'default=noprint_wrappers=1:nokey=1', str(path)],
                            check=True, capture_output=True, text=True)
    length = float(result.stdout.strip())
    if not math.isfinite(length) or length <= 0:
        raise ValueError(f'Invalid media length: {path}')
    return length


def crop(rect):
    """Pad 4% of the frame, then grow to the 944 by 584 laptop screen."""
    x, y, w, h = (float(rect[k]) for k in ('x', 'y', 'w', 'h'))
    if not all(math.isfinite(v) for v in (x, y, w, h)) or min(x, y) < 0 or min(w, h) <= 0 or x+w > 1.000001 or y+h > 1.000001:
        raise ValueError(f'Invalid focus rectangle: {rect}')
    cx, cy = x+w/2, y+h/2
    w, h = min(1, w+.08), min(1, h+.08)
    # Fractions have different units: use the original 1920 by 1080 pixels.
    ratio = (944 / 584) / (1920 / 1080)
    w, h = max(w, h*ratio), max(h, w/ratio)
    if w > 1 or h > 1:
        # Largest screen-shaped rectangle in the frame, centred on the focus.
        w, h = min(1, ratio), min(1, 1/ratio)
    return {'x': max(0, min(1-w, cx-w/2)), 'y': max(0, min(1-h, cy-h/2)), 'w': w, 'h': h}


def lines(text):
    result = []
    for word in text.split():
        if len(word) > 26:
            raise ValueError(f'Caption word exceeds 26 characters: {word}')
        if not result or len(result[-1]) + 1 + len(word) > 26:
            result.append(word)
        else:
            result[-1] += ' ' + word
    return result


def caption_cues(text, start, duration):
    if len(lines(text)) <= 2:
        parts = [text]
    else:
        split_parts = re.split(r'(?<=[.,])\s+', text)
        if len(split_parts) == 1 or any(len(lines(part)) > 2 for part in split_parts):
            raise ValueError(f'Caption needs shorter sentence or comma boundaries: {text}')
        parts = []
        for part in split_parts:
            joined = f'{parts[-1]} {part}' if parts else part
            if parts and len(lines(joined)) <= 2:
                parts[-1] = joined
            else:
                parts.append(part)
    total = sum(len(p) for p in parts)
    result, cursor = [], start
    for i, part in enumerate(parts):
        end = start+duration if i == len(parts)-1 else cursor+duration*len(part)/total
        result.append({'start': round(cursor, 6), 'end': round(end, 6), 'text': part})
        cursor = end
    return result


def film_captions():
    rows = []
    for line in (ROOT / 'docs/FILM.md').read_text(encoding='utf-8').splitlines():
        if re.match(r'^\| \d+ \|', line):
            rows.append(line.split('|')[5].strip())
    if len(rows) != 14:
        raise ValueError('FILM.md must contain exactly 14 caption rows')
    return rows


def windows(events, length, lower, upper, offset):
    """Keep each screen event and remove only gaps, with explicit Later cuts.

    Every mark gets its lead in and one second to read. Expand the windows into
    neighbouring footage until the exact beat budget is filled. Never stretch,
    loop, silently pull back across a scene end, or invent a missing result.
    """
    ranges = []
    for _, t in events:
        a, b = max(lower, t+offset), min(upper, t+1.0)
        if ranges and a <= ranges[-1][1]:
            ranges[-1][1] = max(b, ranges[-1][1])
        else:
            ranges.append([a, b])
    used = sum(b-a for a, b in ranges)
    if used > length + 1e-6:
        raise ValueError(f'Essential moments need {used:.2f}s, beat allows {length}s; review offsets/footage')
    remaining = length-used
    # Fill the smallest gaps first to avoid unnecessary cuts.
    while len(ranges) > 1:
        gap, i = min((ranges[i+1][0]-ranges[i][1], i) for i in range(len(ranges)-1))
        if gap > remaining + 1e-6:
            break
        ranges[i:i+2] = [[ranges[i][0], ranges[i+1][1]]]
        remaining -= gap
    for i, interval in enumerate(ranges):
        limit = ranges[i+1][0] if i+1 < len(ranges) else upper
        add = min(remaining, limit-interval[1])
        interval[1] += add
        remaining -= add
    if remaining > 1e-6:
        add = min(remaining, ranges[0][0]-lower)
        ranges[0][0] -= add
        remaining -= add
    if remaining > 1e-6:
        raise ValueError(f'Not enough source footage: need {remaining:.3f}s more')
    return ranges


def build(marks, lengths):
    if marks.get('failure'):
        raise ValueError('Capture failed; do not compose an incomplete live run')
    facts = marks['facts']
    for field in ('tripId', 'quoteChanged', 'ceiling', 'holdAmounts', 'voidedAmounts', 'capturedAmounts', 'refundAmounts', 'paypal'):
        if not facts.get(field):
            raise ValueError(f'Missing captured fact: {field}')
    captions = film_captions()
    captions[4] = captions[4].replace('$600', facts['ceiling'])
    clips, cues, lower_thirds, cursor = [], [], [], 0
    labels = {2: 'Bryntum Scheduler', 8: 'Bryntum Scheduler', 5: 'PayPal sandbox authorization',
              9: 'PayPal void', 10: 'PayPal capture', 11: 'PayPal refund', 12: 'PayPal webhooks'}
    for n, (length, anchor) in enumerate(zip(LENGTHS, ANCHORS), 1):
        scene = 'phone' if n == 13 else 'desk'
        sm = marks[scene]
        if anchor not in sm:
            raise ValueError(f'Missing mark: {anchor}')
        # Reconciliation clicks are wait footage, not primary story anchors.
        names = [name for name in sm if (name.startswith(f'b{n}-') if n != 13 else name.startswith('phone-'))
                 and not re.match(r'b(?:11-check|12-reload)-', name)
                 and not (n == 1 and name == 'b1-plan-click')]
        if n == 1 and 'b1-fly' not in sm:
            raise ValueError('Missing mark: b1-fly')
        events = sorted(((name, float(sm[name][0])) for name in names), key=lambda item: item[1])
        if any(not math.isfinite(t) or t < 0 or t > lengths[scene] for _, t in events):
            raise ValueError(f'Invalid source mark in beat {n}')
        boundary = marks.get('beats', {}).get(str(n), {})
        lo = float(boundary.get('start', 0))
        hi = min(float(boundary.get('end', lengths[scene])), lengths[scene])
        pieces = windows(events, length, lo, hi, OFFSETS[n])
        for index, (a, b) in enumerate(pieces):
            duration = b-a
            visible = [(name, t) for name, t in events if a <= t <= b]
            src = {'file': MEDIA+scene+'.webm'}
            if scene == 'desk':
                src['crop'] = crop({'x': 0, 'y': 0, 'w': 1, 'h': 1})
            device = {'id': scene, 'type': 'phone' if n == 13 else 'laptop', 'in': 0, 'out': duration,
                      'mediaIn': a, 'volume': 0, 'src': src,
                      'keyframes': [{'time': 0, 'x': 960, 'y': 470 if n == 13 else 408,
                                     'scale': 1.15 if n == 13 else 1.2}]}
            s = {'devices': [device]}
            if index:
                if duration < 1.5:
                    raise ValueError('Later cut needs at least 1.5 seconds')
                s['texts'] = [{'start': 0, 'end': 1.5, 'x': 960, 'y': 60, 'text': 'Later'}]
            clips.append({'start': cursor+sum(y-x for x, y in pieces[:index]), 'in': 0, 'out': duration,
                          'layout': 'scene', 'product': True, 'capture': 'real', 'scene': s})
        cues.extend(caption_cues(captions[n-1].replace('(amount)', facts['quoteChanged']), cursor, length))
        if n in labels:
            lower_thirds.append({'start': cursor+1, 'end': cursor+length-1, 'text': labels[n]})
        cursor += length
    timeline = {'id': 'roamreprise', 'name': 'RoamReprise', 'accent': '#1F6F8B', 'duration': cursor,
                'clips': clips, 'captions': cues, 'lowerThirds': lower_thirds,
                'title': {'start': 0, 'end': 2, 'text': 'RoamReprise'},
                'endCard': {'start': cursor-4, 'end': cursor, 'name': 'RoamReprise',
                            'line': 'PayPal sandbox, test money, free to try', 'link': 'Link in the description'},
                'music': {'file': MEDIA+'music.wav', 'volume': 0.8, 'fadeIn': 1, 'fadeOut': 3}}
    texts = [c['text'] for c in cues+lower_thirds] + ['RoamReprise', *timeline['endCard'].values()]
    for text in texts:
        if isinstance(text, str):
            assert not re.search(r'AI generated', text, re.I), text
            assert not re.search(r'[^\W\d_]\s*[-\u00ad\u2010-\u2015\u2212]\s*[^\W\d_]', text), text
    assert cursor == 170
    return timeline


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--marks', type=Path, default=ROOT/'video/raw/marks.json')
    parser.add_argument('--media-dir', type=Path, default=KIT/'public/media/roamreprise')
    parser.add_argument('--output', type=Path, default=KIT/'timelines/roamreprise.json')
    parser.add_argument('--copy', type=Path, default=ROOT/'docs/video/roamreprise.timeline.json')
    parser.add_argument('--ffprobe', default=shutil.which('ffprobe') or
                        str(KIT/'node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe'))
    args = parser.parse_args()
    marks = json.loads(args.marks.read_text(encoding='utf-8'))
    timeline = build(marks, {scene: probe(args.media_dir/(scene+'.webm'), args.ffprobe) for scene in ('desk', 'phone')})
    text = json.dumps(timeline, indent=2, ensure_ascii=False)+'\n'
    for path in (args.output, args.copy):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
    print(f'170 seconds; {len(timeline["clips"])} clips; {len(timeline["captions"])} caption cues')


if __name__ == '__main__':
    main()
