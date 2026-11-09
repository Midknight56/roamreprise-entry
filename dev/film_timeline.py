"""Build the round 2 film (about 167 seconds) from the one real recording.

The film opens on the failure (beats 1 and 2), then goes back (beat 3, "Earlier"). Each beat is a list of real
segments: a mark from dev/film_capture.mjs, a lead in, and a length. Footage fills the frame, cropped close on the
part the caption is about (never more than 2x). Captions come from docs/FILM.md with every amount and name read
from the recorded run. No network access. Optional paths allow an offline dry run.
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
ID = 'roamreprise-r2'
MEDIA = f'media/{ID}/'
VOICE_PATH = ROOT / 'docs/video/voice-script.json'
VOICE = json.loads(VOICE_PATH.read_text(encoding='utf-8-sig')).get('lines') if VOICE_PATH.is_file() else None
# beat: (length, [(mark, lead in seconds, segment seconds), ...]). Lengths sum to about 167 seconds.
BEATS = {
    1: (10.3, [('b1-trip', -0.3, 4.0), ('b1-cancel-click', -0.8, 2.0), ('b1-hotel', -0.3, 1.5), ('b2-failed', -0.3, 2.8)]),
    2: (6.8, [('b2-strip', -1.4, 6.8)]),
    3: (12, [('b3-form', -0.3, 3.0), ('b3-choice-click', -0.8, 4.0), ('b3-plan-click', -0.5, 1.5), ('b3-plan', -0.3, 3.5)]),
    4: (12, [('b4-tooltip', -0.5, 3.5), ('b4-chip-click', -0.8, 2.0), ('b4-ask-click', -0.6, 1.5), ('b4-changed', -0.3, 5.0)]),
    5: (13, [('b5-quote-click', -0.8, 2.5), ('b5-hold-click', -0.8, 3.0), ('b5-held', -0.3, 7.5)]),
    6: (18, None),  # one segment per card plus the rejected list, shared evenly
    7: (14, [('b7-alt-click', -0.8, 3.0), ('b7-pick-click', -0.8, 3.0), ('b7-preview', -0.3, 8.0)]),
    8: (14, [('b8-use-click', -0.8, 3.0), ('b8-released', -0.3, 11.0)]),
    9: (13, [('b9-hold-click', -0.8, 3.5), ('b9-held', -0.3, 2.0), ('b9-ids', -1.4, 7.5)]),
    # The run pauses 3 s on the captured strip, then scrolls: the strip shot ends before the scroll.
    10: (13, [('b10-confirm-click', -0.8, 3.5), ('b10-captured', -0.3, 3.0), ('b10-ids', -0.3, 6.5)]),
    11: (16, [('b11-cancel-click', -0.8, 3.0), ('b11-replacement', -0.3, 6.0), ('b11-completed', -0.3, 7.0)]),
    12: (12, [('b12-net', -0.3, 6.0), ('b12-webhooks', -0.3, 6.0)]),
    13: (8, [('phone-schedule', -0.3, 4.0), ('phone-money', -0.3, 4.0)]),
    14: (5, [('b14-ids', -0.3, 5.0)]),
}
SUBJECTS = {
    1: ['b1-trip', 'b1-cancel-click'],
    2: ['b2-strip'],
    3: ['b3-form', 'b3-form', 'b3-choice-click'],
    4: ['b4-tooltip', 'b4-tooltip', 'b4-chip-click', 'b4-chip-click', 'b4-changed'],
    5: ['b5-quote-click', 'b5-held', 'b5-held', 'b5-held'],
    6: ['CHEAP', 'CHEAP', 'DEAR', 'DEAR'],
    7: ['b7-alt-click', 'b7-preview', 'b7-preview'],
    8: ['b8-use-click', 'b8-released', 'b8-released'],
    9: ['b9-hold-click', 'b9-ids'],
    10: ['b10-confirm-click', 'b10-captured'],
    11: ['b11-cancel-click', 'b11-replacement', 'b11-replacement'],
    12: ['b12-net', 'b12-webhooks', 'b12-webhooks'],
    13: ['phone-schedule'],
    14: ['b14-ids', 'b14-ids'],
}
CUE_AT_START = {3: 'Earlier', 6: 'Later'}
LABELS = {4: 'Bryntum Scheduler', 7: 'Bryntum Scheduler', 5: 'PayPal authorization', 8: 'PayPal void',
          10: 'PayPal capture', 11: 'PayPal refund', 12: 'PayPal webhooks'}
# A "Later" label marks real waiting in the run (the plan being made, the PayPal hold), not a long still hold.
LATER_MARKS = {'b3-plan', 'b5-held'}
NO_LATER = {1}
CAPTION_END = {3: 'b3-plan-click'}
LABEL_AT = {12: 'b12-webhooks'}
CROP_TOP = {'b12-net'}
CAPTION_TOP = 0.786


def probe(path, executable='ffprobe'):
    result = subprocess.run([str(executable), '-v', 'error', '-show_entries', 'format=duration',
                             '-of', 'default=noprint_wrappers=1:nokey=1', str(path)],
                            check=True, capture_output=True, text=True)
    length = float(result.stdout.strip())
    if not math.isfinite(length) or length <= 0:
        raise ValueError(f'Invalid media length: {path}')
    return length


def crop(rect, top=False):
    """A 16:9 crop around the focus with 3% padding, never zoomed more than 2x.

    The recording is 16:9, so equal width and height fractions keep the frame's shape."""
    x, y, w, h = (float(rect[k]) for k in ('x', 'y', 'w', 'h'))
    if not all(math.isfinite(v) for v in (x, y, w, h)) or min(x, y) < 0 or min(w, h) <= 0 or x+w > 1.000001 or y+h > 1.000001:
        raise ValueError(f'Invalid focus rectangle: {rect}')
    cx, cy = x+w/2, y+h/2
    if h > w or top:
        # A tall panel: fit its width and keep its top (title, state and amounts) in frame.
        size = min(1.0, max(0.5, w+.06))
        top_pos = y-.03
    else:
        size = min(1.0, max(0.5, w+.06, h+.06))
        top_pos = cy-size/2
    return {'x': round(max(0, min(1-size, cx-size/2)), 6), 'y': round(max(0, min(1-size, top_pos)), 6),
            'w': round(size, 6), 'h': round(size, 6)}


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


def caption_cues(text, subjects, starts, beat_start, beat_end, end_override=None):
    units = re.split(r'(?<=[.,])\s+', text)
    if len(units) != len(subjects):
        raise ValueError(f'{len(units)} caption units and {len(subjects)} subjects')
    pairs = list(zip(units, subjects))
    merged = []
    for unit, subject in pairs:
        if merged and merged[-1][1] == subject:
            joined = f'{merged[-1][0]} {unit}'
            if len(lines(joined)) <= 2:
                merged[-1] = (joined, subject)
                continue
        merged.append((unit, subject))
    for cue_text, _ in merged:
        if len(lines(cue_text)) > 2:
            raise ValueError(f'Caption needs shorter sentence or comma boundaries: {text}')
    groups = []
    for cue_text, subject in merged:
        if groups and groups[-1][0] == subject:
            groups[-1][1].append(cue_text)
        else:
            groups.append((subject, [cue_text]))
    result = []
    prev_start = beat_start
    last_end = beat_end if end_override is None else end_override
    for i, (subject, parts) in enumerate(groups):
        g_start = starts[subject]
        if g_start < prev_start:
            raise ValueError(f'Group starts before previous group: {text}')
        prev_start = g_start
        g_end = last_end if i == len(groups) - 1 else starts[groups[i+1][0]]
        g_duration = g_end - g_start
        total = sum(len(p) for p in parts)
        cursor = g_start
        for j, part in enumerate(parts):
            end = g_end if j == len(parts) - 1 else cursor + g_duration * len(part) / total
            if end - cursor < 1.5 - 1e-6:
                raise ValueError(f'Cue shorter than 1.5s: {text}')
            result.append({'start': round(cursor, 6), 'end': round(end, 6), 'text': part, 'subject': subject})
            cursor = end
    return result


def film_captions():
    rows = []
    in_round2 = True
    for line in (ROOT / 'docs/FILM.md').read_text(encoding='utf-8').splitlines():
        if line.startswith('## Round 1 cut'):
            in_round2 = False
        if in_round2 and re.match(r'^\| \d+ \|', line):
            rows.append(line.split('|')[4].strip())
    if len(rows) != 14:
        raise ValueError(f'FILM.md must contain exactly 14 round 2 caption rows, found {len(rows)}')
    return rows


def usd(cents):
    return f'${cents/100:,.2f}'


def fill(captions, facts):
    ok = sorted((c for c in facts['candidates'] if c['ok']), key=lambda c: c['totalCents'])
    if len(ok) < 2:
        raise ValueError('Beat 6 needs two checked hotels')
    cheap, dear = ok[0], ok[-1]
    net = sum(facts['capturedCents']) - sum(facts['refundCents'])
    values = {
        '(ceiling)': facts['ceiling'], '(quote)': facts['holdAmounts'][0], '(new total)': facts['holdAmounts'][1],
        '(cheap name)': cheap['name'], '(dear name)': dear['name'],
        '(class price)': facts['cancelledPrice'], '(replacement price)': facts['replacementPrice'],
        '(refund)': facts['refundAmounts'][0], '(net)': usd(net),
    }
    if cheap['dropped'] and not dear['dropped']:
        values['(dropped activity)'] = cheap['dropped'][0]
    else:
        # No trade off in this run: say only what the cards show.
        captions[5] = f'Two hotels fit. {cheap["name"]} costs {cheap["total"]}. {dear["name"]} costs {dear["total"]}. The others fail a check'
    out = []
    for text in captions:
        for key, value in values.items():
            text = text.replace(key, value)
        if re.search(r'\([a-z ]+\)', text):
            raise ValueError(f'Unfilled caption placeholder: {text}')
        out.append(text)
    return out


def segments_for(n, marks):
    length, spec = BEATS[n]
    if spec is None:
        # Cards follow the caption: the cheaper hotel first, then the dearer one, then the rejected list.
        cards = sorted((k for k in marks['desk'] if k.startswith('b6-card-')), key=lambda k: int(k.rsplit('-', 1)[1]))
        checked = [c for c in marks['facts']['candidates'] if c['ok']]
        if len(cards) == len(checked) == 2:
            cheap = min(range(2), key=lambda i: checked[i]['totalCents'])
            spec = [(cards[cheap], -0.3, 8.5), (cards[1-cheap], -0.3, 4.5), ('b6-rejected', -0.3, 5.0)]
        else:
            names = cards + ['b6-rejected']
            each = round(length/len(names), 6)
            spec = [(name, -0.3, each) for name in names]
            spec[-1] = (spec[-1][0], -0.3, round(length-each*(len(names)-1), 6))
    if n == 7 and 'b7-alt-click' not in marks['desk']:
        spec = [('b7-pick-click', -0.8, 4.0), ('b7-preview', -0.3, 10.0)]
    if abs(sum(s[2] for s in spec)-length) > 1e-6:
        raise ValueError(f'Beat {n} segments do not fill {length}s')
    return length, spec


def subjects_for(n, marks):
    sub = list(SUBJECTS[n])
    if n == 6:
        cards = sorted((k for k in marks['desk'] if k.startswith('b6-card-')), key=lambda k: int(k.rsplit('-', 1)[1]))
        checked = [c for c in marks['facts']['candidates'] if c['ok']]
        if len(cards) == len(checked) == 2:
            cheap = min(range(2), key=lambda i: checked[i]['totalCents'])
            cheap_mark, dear_mark = cards[cheap], cards[1-cheap]
        else:
            cheap_mark, dear_mark = cards[0], cards[1]
        sub = [cheap_mark if s == 'CHEAP' else dear_mark if s == 'DEAR' else s for s in sub]
    elif n == 7 and 'b7-alt-click' not in marks['desk']:
        sub = ['b7-pick-click' if s == 'b7-alt-click' else s for s in sub]
    return sub


def check_caption_subjects(timeline, marks):
    for cue in timeline['captions']:
        # The clip on screen is the last one that has started (rounded in and out times can make a clip end
        # a microsecond after the next one starts).
        c_match = None
        for clip in timeline['clips']:
            if clip['start'] <= cue['start'] + 1e-6:
                c_match = clip
        if c_match is None or c_match.get('mark') != cue.get('subject'):
            raise ValueError(f"{cue['text']}: starts before its subject is on screen")
        clip_end = c_match['start'] + (c_match['out'] - c_match['in'])
        if cue['start'] > clip_end - 1.0 + 1e-6:
            raise ValueError(f"{cue['text']}: starts at the end of its shot")
        if 'crop' in c_match:
            r = marks['rects'][cue['subject']]
            c = c_match['crop']
            rx, ry, rw, rh = r['x'], r['y'], r['w'], r['h']
            cx, cy, cw, ch = c['x'], c['y'], c['w'], c['h']
            if not (rx >= cx - 0.001 and rx + rw <= cx + cw + 0.001):
                raise ValueError(f"{cue['text']}: subject box is off screen or under the caption")
            if not (ry >= cy - 0.001):
                raise ValueError(f"{cue['text']}: subject box is off screen or under the caption")
            if not ((ry - cy) / ch < CAPTION_TOP):
                raise ValueError(f"{cue['text']}: subject box is off screen or under the caption")
            if rh / ch < 0.5 and not ((ry + rh - cy) / ch <= CAPTION_TOP):
                raise ValueError(f"{cue['text']}: subject box is off screen or under the caption")


def build(marks, lengths):
    if marks.get('failure'):
        raise ValueError('Capture failed; do not compose an incomplete live run')
    facts = marks['facts']
    for field in ('tripId', 'ceiling', 'holdAmounts', 'capturedAmounts', 'refundAmounts', 'candidates', 'cancelledPrice', 'replacementPrice'):
        if not facts.get(field):
            raise ValueError(f'Missing captured fact: {field}')
    captions = fill(film_captions(), facts)
    clips, cues, lower, cursor = [], [], [], 0.0
    for n in range(1, 15):
        length, spec = segments_for(n, marks)
        scene = 'phone' if n == 13 else 'desk'
        later_at, t, previous_end = [], cursor, None
        starts = {}
        for name, lead, seconds in spec:
            if name not in marks[scene]:
                raise ValueError(f'Missing mark: {name}')
            source_in = max(0.0, float(marks[scene][name][0]) + lead)
            source_out = source_in + seconds
            if source_out > lengths[scene] + 1e-6:
                raise ValueError(f'Segment {name} runs past the end of {scene}.webm')
            if name in LATER_MARKS:
                later_at.append(t)
            previous_end = source_out
            clip = {'start': round(t, 6), 'file': MEDIA+scene+'.webm', 'in': round(source_in, 6), 'out': round(source_out, 6),
                    'volume': 0, 'layout': 'phone' if scene == 'phone' else 'full', 'product': True, 'capture': 'real',
                    'mark': name}
            if scene == 'desk':
                clip['crop'] = crop(marks['rects'][name], top=name in CROP_TOP)
            clips.append(clip)
            if name not in starts:
                starts[name] = t
            t += seconds
        sub = subjects_for(n, marks)
        units = re.split(r'(?<=[.,])\s+', captions[n-1])
        if len(units) != len(sub):
            raise ValueError(f'Beat {n} has {len(units)} caption units and {len(sub)} subjects')
        end_override = starts[CAPTION_END[n]] if n in CAPTION_END else None
        cues.extend(caption_cues(captions[n-1], sub, starts, cursor, cursor+length, end_override=end_override))
        markers = ([(cursor, CUE_AT_START[n])] if n in CUE_AT_START else []) + ([] if n in NO_LATER else [(at, 'Later') for at in later_at])
        busy = cursor
        for at, word in markers:
            lower.append({'start': round(at, 6), 'end': round(at+1.5, 6), 'text': word})
            busy = at+1.5
        if n in LABELS:
            begin = starts[LABEL_AT[n]] if n in LABEL_AT else max(cursor+0.5, busy+0.2)
            if begin + 2 < cursor+length:
                lower.append({'start': round(begin, 6), 'end': round(min(cursor+length-0.5, begin+3.5), 6), 'text': LABELS[n]})
        cursor += length
    lower.sort(key=lambda c: c['start'])
    for a, b in zip(lower, lower[1:]):
        if b['start'] < a['end']:
            a['end'] = b['start']
    timeline = {'id': ID, 'name': 'RoamReprise', 'accent': '#1F6F8B', 'duration': round(cursor, 6),
                'clips': clips, 'captions': cues, 'lowerThirds': lower,
                'title': {'start': 0, 'end': 2, 'text': 'RoamReprise'},
                'endCard': {'start': cursor-4, 'end': cursor, 'name': 'RoamReprise',
                            'line': 'Free to try', 'link': 'Link in the description'},
                'music': {'file': MEDIA+'music.wav', 'volume': 0.8, 'fadeIn': 1, 'fadeOut': 3}}
    texts = [c['text'] for c in cues+lower] + [timeline['title']['text'], *timeline['endCard'].values()]
    for text in texts:
        if isinstance(text, str):
            if re.search(r'sandbox|test money|test card', text, re.I):
                raise ValueError(f'Text matches forbidden words: {text}')
            assert not re.search(r'AI generated', text, re.I), text
            assert not re.search(r'[^\W\d_]\s*[-\u00ad\u2010-\u2015\u2212]\s*[^\W\d_]', text), text
    assert 160 <= cursor < 180, cursor
    check_caption_subjects(timeline, marks)
    return timeline


def render_cut(timeline, media_dir, ffmpeg):
    """Cut and crop every segment with ffmpeg into one continuous 1920x1080 video.

    The kit then plays a single clip. Measured 9 Nov 2026: with one kit clip per segment, the kit drew nothing for 1 to
    5 frames at 39 to 42 of the cuts (black flashes on its dark background); one continuous clip has no such cuts."""
    work = media_dir / 'segments'
    work.mkdir(parents=True, exist_ok=True)
    names = []
    for i, clip in enumerate(timeline['clips']):
        out = work / f'{i:02d}.mp4'
        src = media_dir / Path(clip['file']).name
        if clip['layout'] == 'phone':
            vf = 'scale=-2:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:0:color=0xF4F1EA'
        else:
            c = clip['crop']
            vf = (f"crop=trunc(iw*{c['w']}/2)*2:trunc(ih*{c['h']}/2)*2:trunc(iw*{c['x']}):trunc(ih*{c['y']}),"
                  'scale=1920:1080:flags=lanczos')
        # Exactly round(seconds x 60) frames, so 38 segments add up to the plan (the recording has a variable frame rate).
        count = round((clip['out']-clip['in'])*60)
        subprocess.run([str(ffmpeg), '-v', 'error', '-y', '-ss', f"{clip['in']:.3f}", '-i', str(src),
                        '-vf', vf + ',fps=60,tpad=stop_mode=clone:stop_duration=1,setsar=1,format=yuv420p',
                        '-frames:v', str(count), '-an', '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', str(out)],
                       check=True)
        names.append(out)
    listing = work / 'list.txt'
    listing.write_text(''.join(f"file '{n.as_posix()}'\n" for n in names), encoding='utf-8')
    cut = media_dir / 'cut.mp4'
    subprocess.run([str(ffmpeg), '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(listing),
                    '-c', 'copy', str(cut)], check=True)
    return cut


def kit_timeline(timeline, length):
    """The kit's copy: one continuous clip; captions, labels, title, end card and music unchanged."""
    if abs(length - timeline['duration']) > 0.2:
        raise ValueError(f'Cut is {length:.3f}s, the plan is {timeline["duration"]}s')
    kit = dict(timeline)
    kit['clips'] = [{'start': 0, 'file': MEDIA+'cut.mp4', 'in': 0, 'out': timeline['duration'], 'volume': 0,
                     'layout': 'full', 'product': True, 'capture': 'real'}]
    kit['captions'] = [{k: v for k, v in cue.items() if k != 'subject'} for cue in timeline['captions']]
    return kit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--marks', type=Path, default=ROOT/'video/raw/marks.json')
    parser.add_argument('--media-dir', type=Path, default=KIT/'public'/MEDIA)
    parser.add_argument('--output', type=Path, default=KIT/f'timelines/{ID}.json')
    parser.add_argument('--copy', type=Path, default=ROOT/f'docs/video/{ID}.timeline.json')
    parser.add_argument('--ffprobe', default=shutil.which('ffprobe') or
                        str(KIT/'node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe'))
    parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg') or 'ffmpeg')
    args = parser.parse_args()
    marks = json.loads(args.marks.read_text(encoding='utf-8'))
    timeline = build(marks, {scene: probe(args.media_dir/(scene+'.webm'), args.ffprobe) for scene in ('desk', 'phone')})
    # The docs copy keeps the segment plan; the kit gets one continuous clip cut from it.
    args.copy.parent.mkdir(parents=True, exist_ok=True)
    args.copy.write_text(json.dumps(timeline, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
    cut = render_cut(timeline, args.media_dir, args.ffmpeg)
    kit = kit_timeline(timeline, probe(cut, args.ffprobe))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(kit, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
    print(f'{timeline["duration"]} seconds; {len(timeline["clips"])} clips; {len(timeline["captions"])} caption cues')
    for cue in timeline['captions']:
        print(f'  {cue["start"]:7.2f}  {cue["text"]}')


if __name__ == '__main__':
    main()
