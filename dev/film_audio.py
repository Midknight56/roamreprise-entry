"""Makes the film's sound track in code: a calm music bed plus the kit's own effects at the film's real moments.

Licence clean: the music is made here from sine waves and a plucked string model (no samples); the effects are the
showcase kit's own (`sfx/whoosh.wav`, made in code) and Kenney's CC0 packs (`sfx/kenney/`, licence files beside them).
No voice. Nylon style plucked strings over a soft low pad at 96 BPM.

Usage: python -P dev/film_audio.py   (after dev/film_timeline.py; reads the kit timeline and video/raw/marks.json)
Writes A:/Projects/showcase-kit/public/media/roamreprise-r2/music.wav (48 kHz stereo).
"""
import argparse
import json
import wave
from pathlib import Path

import numpy as np

SR = 48000
KIT = Path("A:/Projects/showcase-kit")
TIMELINE = Path(__file__).resolve().parent.parent / "docs/video/roamreprise-r2.timeline.json"  # the segment plan, not the kit copy
MARKS = Path(__file__).resolve().parent.parent / "video/raw/marks.json"
OUT = KIT / "public/media/roamreprise-r2/music.wav"
rng = np.random.default_rng(25)

BPM = 96
BEAT = 60 / BPM
BAR = 4 * BEAT
# A minor / C major: Am9, Fmaj7, Cmaj7, G6 (MIDI notes)
CHORDS = [[45, 52, 55, 59, 60], [41, 48, 52, 57, 60], [48, 55, 59, 64, 67], [43, 50, 55, 59, 64]]


def hz(note):
    return 440.0 * 2 ** ((note - 69) / 12)


def envelope(n, attack, release):
    env = np.ones(n)
    a, r = min(n, int(attack * SR)), min(n, int(release * SR))
    if a:
        env[:a] = np.linspace(0, 1, a)
    if r:
        env[-r:] *= np.linspace(1, 0, r)
    return env


def pad(note, seconds):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for cents in (-4, 0, 4):
        f = hz(note) * 2 ** (cents / 1200)
        for k, amp in ((1, 1.0), (2, 0.35), (3, 0.12)):
            out += amp * np.sin(2 * np.pi * f * k * t + rng.uniform(0, 6.28))
    return out * envelope(n, 0.9, 1.2) / 3


def pluck(note, seconds):
    """Karplus Strong plucked string: noise through a delay line with a soft average."""
    n = int(seconds * SR)
    period = int(SR / hz(note))
    buf = rng.uniform(-1, 1, period)
    out = np.zeros(n)
    for i in range(n):
        out[i] = buf[i % period]
        buf[i % period] = 0.996 * 0.5 * (buf[i % period] + buf[(i + 1) % period])
    return out * envelope(n, 0.003, 0.25)


def bass(note, seconds):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * hz(note - 12) * t) * envelope(n, 0.02, seconds * 0.6)


def place(track, sound, at, gain, pan=0.0):
    i = int(at * SR)
    if i >= track.shape[0]:
        return
    sound = sound[: track.shape[0] - i]
    if sound.ndim == 1:
        sound = np.stack([sound * (1 - max(pan, 0)), sound * (1 + min(pan, 0))], axis=1)
    track[i : i + sound.shape[0]] += gain * sound


def read_wav(path):
    with wave.open(str(path)) as w:
        assert w.getframerate() == SR and w.getsampwidth() == 2, path
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(float) / 32768
        return data.reshape(-1, w.getnchannels()) if w.getnchannels() == 2 else np.stack([data, data], axis=1)


def music(duration):
    track = np.zeros((int((duration + 2) * SR), 2))
    bars = int(duration / BAR) + 2
    pad_cache, pluck_cache = {}, {}
    for b in range(bars):
        start = b * BAR
        chord = CHORDS[b % 4]
        for j, note in enumerate(chord[1:], start=1):  # the bass carries the root
            key = (note, "pad")
            if key not in pad_cache:
                pad_cache[key] = pad(note, BAR + 1.2)
            place(track, pad_cache[key], start, 0.018, pan=(j - 2) * 0.15)
        place(track, bass(chord[0], BAR * 0.95), start, 0.03)
        if b >= 1:  # the arpeggio enters after the first bar
            order = [chord[1], chord[2], chord[3], chord[4], chord[3], chord[2], chord[1] + 12, chord[3]]
            for k, note in enumerate(order):
                if note not in pluck_cache:
                    pluck_cache[note] = pluck(note + 12, BEAT * 1.5)
                place(track, pluck_cache[note], start + k * BEAT / 2, 0.3 if k % 2 == 0 else 0.22, pan=0.3 if k % 2 else -0.3)
    # a soft echo on the whole bed (3/8 of a bar), and a gentle high cut by a running average
    echo = int(BEAT * 1.5 * SR)
    track[echo:] += 0.25 * track[:-echo]
    kernel = np.ones(9) / 9
    for ch in range(2):
        track[:, ch] = np.convolve(track[:, ch], kernel, mode="same")
    return track


def moments(timeline, marks):
    """Map only events actually present in a clip, including both sides of cuts."""
    def film_time(scene, name):
        seconds = marks[scene][name][0]
        result = []
        for clip in timeline["clips"]:
            # Round 2 clips are full frame or phone footage: file, in and out are on the clip itself.
            if not clip["file"].endswith(f"/{scene}.webm"):
                continue
            offset = seconds - clip["in"]
            if 0 <= offset < clip["out"] - clip["in"]:
                result.append(clip["start"] + offset)
        return result

    # A whoosh only where a beat changes, not at every close crop inside a beat.
    import importlib.util
    spec = importlib.util.spec_from_file_location("film_timeline", Path(__file__).with_name("film_timeline.py"))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    BEATS = module.BEATS
    starts, at = set(), 0
    for n in sorted(BEATS):
        starts.add(round(at, 3)); at += BEATS[n][0]
    cuts = [clip["start"] for clip in timeline["clips"][1:] if round(clip["start"], 3) in starts]
    taps = [t for scene in ("desk", "phone") for name in marks[scene]
            if name.endswith("-click") for t in film_time(scene, name)]
    goods = [t for name in ("b5-held", "b8-released", "b9-held", "b10-captured", "b11-completed")
             for t in film_time("desk", name)]
    return cuts, sorted(set(taps)), sorted(set(goods))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeline", type=Path, default=TIMELINE)
    parser.add_argument("--marks", type=Path, default=MARKS)
    parser.add_argument("--kit", type=Path, default=KIT)
    parser.add_argument("--output", type=Path, default=OUT)
    args = parser.parse_args()
    timeline = json.loads(args.timeline.read_text(encoding="utf-8"))
    marks = json.loads(args.marks.read_text(encoding="utf-8"))
    duration = timeline["duration"]
    track = music(duration)
    track /= np.abs(track).max() / 0.5  # the bed peaks at half scale, under the effects
    whoosh = read_wav(args.kit / "public/sfx/whoosh.wav")
    select = read_wav(args.kit / "public/sfx/kenney/select_002.wav")
    confirm = read_wav(args.kit / "public/sfx/kenney/confirmation_002.wav")
    cuts, taps, goods = moments(timeline, marks)
    for t in cuts:
        place(track, whoosh, max(0, t - 0.42), 0.22)
    for t in taps:
        place(track, select, t, 0.55)
    for t in goods:
        place(track, confirm, t, 0.4)
    track = track[: int(duration * SR)]
    track /= np.abs(track).max() / (10 ** (-1 / 20))  # peak at -1 dBFS; the timeline sets the level
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.rint(np.clip(track, -1, 1) * 32767)).astype("<i2").tobytes())
    print(f"{args.output} {duration} s; whooshes {len(cuts)}, taps {len(taps)}, confirmations {len(goods)}")
    print("taps at", [round(t, 2) for t in taps], "confirmations at", [round(t, 2) for t in goods])


if __name__ == "__main__":
    main()
