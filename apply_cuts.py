#!/usr/bin/env python3
# Run with python3 apply_cuts.py
import argparse
import json
import shutil
import shlex
import subprocess
import tempfile
from pathlib import Path


def seconds(us):
    return f'{us / 1_000_000:.6f}'


def kept_ranges(data, duration):
    if data.get('schemaVersion') != 1 or data.get('operation') != 'remove' or data.get('timeUnit') != 'microseconds':
        raise ValueError('Expected schemaVersion 1, remove operation, microseconds')
    cursor = 0
    keep = []
    for cut in sorted(data['cuts'], key=lambda c: c['startUs']):
        start, end = cut['startUs'], cut['endUs']
        if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end <= duration:
            raise ValueError(f'Invalid cut: {cut}')
        if start > cursor:
            keep.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < duration:
        keep.append((cursor, duration))
    return keep


def prompt_path(label):
    while True:
        raw = input(f'{label} (drag file here and press Enter): ').strip()
        if not raw:
            continue
        candidates = [Path(raw).expanduser()]
        try:
            parts = shlex.split(raw)
            if len(parts) == 1:
                candidates.append(Path(parts[0]).expanduser())
        except ValueError:
            pass
        for path in candidates:
            if path.is_file():
                return path
        print('File not found. Please try again.')


def main():
    p = argparse.ArgumentParser(description='Remove JSON cut ranges from a video.')
    p.add_argument('json', type=Path, nargs='?')
    p.add_argument('video', type=Path, nargs='?')
    p.add_argument('-o', '--output', type=Path)
    p.add_argument('--software', action='store_true', help='Use libx264 instead of Apple hardware encoding')
    p.add_argument('--bitrate', default='12M', help='Apple encoder video bitrate (default: 12M)')
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args()
    args.json = args.json or prompt_path("JSON cuts file")
    args.video = args.video or prompt_path("Source video")
    data = json.loads(args.json.read_text())
    duration = data['source']['durationUs']
    keep = kept_ranges(data, duration)
    if not keep:
        raise ValueError('Cuts remove the entire video')
    output = args.output or args.video.with_name(args.video.stem + '_edited.mp4')
    if output.resolve() == args.video.resolve() or output.exists():
        raise ValueError(f'Output already exists or is the source: {output}')
    if output.suffix.lower() != '.mp4':
        raise ValueError('Output must have an .mp4 extension')
    if not args.video.is_file():
        raise ValueError(f'Video not found: {args.video}')
    if data['source'].get('fileSizeBytes') not in (None, args.video.stat().st_size):
        raise ValueError('Video size differs from JSON source; check that you selected the original video')
    total = sum(b-a for a,b in keep)
    print(f'Original: {float(seconds(duration))/60:.2f} min | Removed: {float(seconds(duration-total))/60:.2f} min | Final: {float(seconds(total))/60:.2f} min', flush=True)
    print(f'{len(data["cuts"])} cuts, {len(keep)} retained segments. Output: {output}', flush=True)
    if args.dry_run:
        return
    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            raise ValueError(f'{tool} not found. Install FFmpeg first.')
    probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(args.video)]))
    audio = any(s['codec_type']=='audio' for s in probe['streams'])
    actual = float(probe['format']['duration'])
    if abs(actual-duration/1e6)>0.25:
        raise ValueError(f'Video duration ({actual}s) differs from JSON source ({seconds(duration)}s)')
    encoder = ['-c:v','libx264','-preset','fast','-crf','18'] if args.software else ['-c:v','h264_videotoolbox','-b:v',args.bitrate]
    # Encode retained intervals independently with accurate input seeking, then join without re-encoding video.
    with tempfile.TemporaryDirectory(prefix='video-cuts-', dir=output.resolve().parent) as tmp:
        tmp = Path(tmp)
        for i,(start,end) in enumerate(keep):
            print(f'Segment {i+1}/{len(keep)}: {seconds(start)} - {seconds(end)}', flush=True)
            cmd = ['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-ss',seconds(start),'-i',str(args.video),'-t',seconds(end-start),'-map','0:v:0']
            if audio:
                cmd += ['-map','0:a:0']
            cmd += encoder + ['-pix_fmt','yuv420p']
            if audio:
                cmd += ['-c:a','aac','-b:a','192k']
            subprocess.run(cmd+[str(tmp/f'{i:04d}.mp4')],check=True)
        manifest = tmp/'segments.txt'
        manifest.write_text(''.join(f"file '{i:04d}.mp4'\n" for i in range(len(keep))))
        final = tmp/'final.mp4'
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-f','concat','-safe','0','-i',str(manifest),'-c','copy','-movflags','+faststart',str(final)],check=True)
        if output.exists():
            raise ValueError(f'Output already exists: {output}')
        final.rename(output)
    print(f'Done: {output}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f'Error: {exc}')
