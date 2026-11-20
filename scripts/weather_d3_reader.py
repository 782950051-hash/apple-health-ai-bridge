#!/usr/bin/env python3
"""D3 read-only candidate adapter; reuse D2's tested validation and stable reads."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from apple_weather_d2 import FILENAME, _stable_bytes, _unique_object, valid_date, validate_weather


def read_candidates(directory, *, now=None, stability_seconds=0.25):
    now = now or datetime.now(timezone.utc)
    result = {'records': [], 'rejected_count': 0, 'normalization_issues': {}, 'status': 'ok'}
    try:
        paths = sorted(Path(directory).iterdir())
    except OSError:
        return dict(result, status='directory_unavailable')
    for path in paths:
        match = FILENAME.fullmatch(path.name)
        if not match:
            continue
        try:
            filename_date = valid_date(match['date']).isoformat()
            raw = _stable_bytes(path, now, stability_seconds)
            value = json.loads(raw.decode('utf-8-sig'), object_pairs_hook=_unique_object,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite_json')))
            if not isinstance(value, dict):
                raise ValueError('invalid_object')
            diagnostics = []
            data = validate_weather(value, value.get('forecast_date'), now, diagnostics=diagnostics)
            for code in diagnostics:
                result['normalization_issues'][code] = result['normalization_issues'].get(code, 0) + 1
            if data['forecast_date'] != filename_date:
                raise ValueError('filename_date_mismatch')
            if match['time'] and datetime.fromisoformat(data['observed_at']).strftime('%H%M%S') != match['time']:
                raise ValueError('filename_timestamp_mismatch')
            result['records'].append({'weather': data, 'filename': path.name,
                                     'sha256': hashlib.sha256(raw).hexdigest()})
        except (OSError, ValueError, TypeError, OverflowError, KeyError):
            result['rejected_count'] += 1
    result['records'].sort(key=lambda x: (datetime.fromisoformat(x['weather']['observed_at']), x['sha256']))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--now', required=True)
    args = parser.parse_args()
    print(json.dumps(read_candidates(args.directory, now=datetime.fromisoformat(args.now)), ensure_ascii=False))
