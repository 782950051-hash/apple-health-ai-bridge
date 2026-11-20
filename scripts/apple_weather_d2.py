#!/usr/bin/env python3
"""Independent D2 reader/preview; no sender, model, outbox, DB or background job."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ICLOUD_DIR = Path.home() / 'Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Shortcuts/AppleHealth-HealthData'
PRIVATE_DIR = Path.home() / 'Library/Application Support/AppleHealthUpload'
FIELDS = {'schema_version', 'source', 'observed_at', 'forecast_date', 'location_name',
          'temperature_max_c', 'temperature_min_c', 'condition'}
OPTIONAL_WEATHER_FIELDS = {'temperature_current_c', 'temperature_feels_like_c',
                           'precipitation_probability_pct'}
RAW_WEATHER_FIELDS = {
    'temperature_current_raw', 'temperature_current_source',
    'temperature_current_raw_unit', 'temperature_current_raw_type',
    'temperature_feels_like_raw', 'temperature_feels_like_source',
    'temperature_feels_like_raw_unit', 'temperature_feels_like_raw_type',
    'precipitation_probability_raw', 'precipitation_probability_source',
    'precipitation_probability_raw_unit', 'precipitation_probability_raw_type',
}
CURRENT_TEMPERATURE_SOURCE = 'apple_weather_current_conditions.temperature'
FEELS_LIKE_SOURCE = 'apple_weather_current_conditions.feels_like'
DAILY_PRECIPITATION_SOURCE = 'apple_weather_daily_forecast.precipitation_chance'
FILENAME = re.compile(r'weather-(?P<date>\d{4}-\d{2}-\d{2})(?:-(?P<time>\d{6}))?\.json\Z')
TIMESTAMP = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\Z')


def valid_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('invalid_date')
    return date.fromisoformat(value)


def _decimal(value):
    if type(value) in (int, float):
        return Decimal(str(value))
    if isinstance(value, str):
        return Decimal(value.strip())
    raise ValueError('raw_value_type')


def _temperature_c(value, unit):
    if isinstance(value, str):
        match = re.fullmatch(r'\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(°\s*[CF]|℃|℉|[CF])\s*', value, re.IGNORECASE)
        if match:
            value = match.group(1)
            unit = match.group(2).replace(' ', '').upper().replace('℃', '°C').replace('℉', '°F')
    amount = _decimal(value)
    if unit in ('°C', 'C'):
        return float(amount)
    if unit in ('°F', 'F'):
        return float((amount - Decimal(32)) * Decimal(5) / Decimal(9))
    raise ValueError('temperature_unit_unknown')


def _precipitation_pct(value, unit):
    if isinstance(value, str):
        match = re.fullmatch(r'\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([%％])\s*', value)
        if match:
            value = match.group(1)
            if unit not in ('embedded', 'percent_0_100', 'percent'):
                raise ValueError('precipitation_unit_mismatch')
            unit = 'percent_0_100'
    amount = _decimal(value)
    if unit in ('fraction_0_1', 'ratio_0_1'):
        amount *= Decimal(100)
    elif unit not in ('percent_0_100', 'percent'):
        raise ValueError('precipitation_unit_unknown')
    if not amount.is_finite() or not Decimal(0) <= amount <= Decimal(100):
        raise ValueError('precipitation_out_of_range')
    return float(amount)


def _normalize_raw_optional_fields(data, diagnostics):
    normalized = dict(data)
    specs = (
        ('temperature_current_raw', 'temperature_current_source',
         'temperature_current_raw_unit', 'temperature_current_raw_type',
         CURRENT_TEMPERATURE_SOURCE, 'temperature_current_c', _temperature_c),
        ('temperature_feels_like_raw', 'temperature_feels_like_source',
         'temperature_feels_like_raw_unit', 'temperature_feels_like_raw_type',
         FEELS_LIKE_SOURCE, 'temperature_feels_like_c', _temperature_c),
        ('precipitation_probability_raw', 'precipitation_probability_source',
         'precipitation_probability_raw_unit', 'precipitation_probability_raw_type',
         DAILY_PRECIPITATION_SOURCE, 'precipitation_probability_pct', _precipitation_pct),
    )
    for raw_key, source_key, unit_key, type_key, expected_source, output_key, convert in specs:
        if raw_key not in data:
            continue
        normalized.setdefault(output_key, None)
        raw = data[raw_key]
        if raw is None:
            continue
        if isinstance(raw, str) and raw.strip().lower() in ('', 'null', 'none', 'n/a'):
            diagnostics.append(output_key + ':raw_unavailable')
            continue
        try:
            if data.get(source_key) != expected_source:
                raise ValueError('source_mismatch')
            raw_type = data.get(type_key)
            if raw_type not in ('shortcuts_text', 'shortcuts_number'):
                raise ValueError('raw_type_unknown')
            unit = data.get(unit_key)
            if (output_key == 'precipitation_probability_pct'
                    and raw_type == 'shortcuts_text'
                    and unit == 'embedded'
                    and isinstance(raw, str)
                    and re.fullmatch(r'\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*', raw)):
                # WeatherKit daily precipitationChance is a 0..1 fraction.
                unit = 'fraction_0_1'
            converted = convert(raw, unit)
            if not math.isfinite(converted):
                raise ValueError('nonfinite_value')
            if output_key == 'precipitation_probability_pct':
                if not 0 <= converted <= 100:
                    raise ValueError('precipitation_out_of_range')
            elif not -100 <= converted <= 65:
                raise ValueError('temperature_out_of_range')
            if normalized.get(output_key) is None:
                normalized[output_key] = converted
        except (ValueError, TypeError, ArithmeticError) as error:
            code = error.args[0] if error.args and isinstance(error.args[0], str) else 'unusable'
            diagnostics.append(output_key + ':' + code)
    return normalized


def validate_weather(data, report_date, now, *, diagnostics=None):
    target = valid_date(report_date)
    if now.tzinfo is None:
        raise ValueError('aware_now_required')
    diagnostics = diagnostics if diagnostics is not None else []
    if (not isinstance(data, dict) or not FIELDS.issubset(data)
            or not set(data).issubset(FIELDS | OPTIONAL_WEATHER_FIELDS | RAW_WEATHER_FIELDS)):
        raise ValueError('invalid_fields')
    if data['schema_version'] != '1.0' or data['source'] != 'apple_weather_shortcuts':
        raise ValueError('invalid_source_or_schema')
    stamp = data['observed_at']
    if not isinstance(stamp, str) or not TIMESTAMP.fullmatch(stamp):
        raise ValueError('invalid_observation_timestamp')
    observed = datetime.fromisoformat(stamp)
    if abs(observed.utcoffset()) > timedelta(hours=14):
        raise ValueError('invalid_offset')
    forecast = valid_date(data['forecast_date'])
    # Offset belongs to the exporting phone; never use the Mac's local timezone.
    if forecast != target or observed.date() != forecast or now.astimezone(observed.tzinfo).date() != target:
        raise ValueError('not_current_report_day')
    if observed > now + timedelta(minutes=2):
        raise ValueError('future_observation')
    for name in ('location_name', 'condition'):
        value = data[name]
        if not isinstance(value, str) or not value.strip() or len(value) > 120 or any(ord(c) < 32 or c in '\u2028\u2029' for c in value):
            raise ValueError('invalid_weather_text')
    for name in ('temperature_max_c', 'temperature_min_c'):
        value = data[name]
        if type(value) not in (int, float) or not math.isfinite(value) or not -100 <= value <= 65:
            raise ValueError('invalid_temperature')
    if data['temperature_min_c'] > data['temperature_max_c']:
        raise ValueError('temperature_order')
    data = _normalize_raw_optional_fields(data, diagnostics)
    for name in ('temperature_current_c', 'temperature_feels_like_c'):
        value = data.get(name)
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or not -100 <= value <= 65):
            raise ValueError('invalid_' + name)
    probability = data.get('precipitation_probability_pct')
    if probability is not None and (type(probability) not in (int, float) or not math.isfinite(probability) or not 0 <= probability <= 100):
        raise ValueError('invalid_precipitation_probability_pct')
    return dict(data)


def _unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError('duplicate_json_key')
        obj[key] = value
    return obj


def _signature(s):
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def _stable_bytes(path, now, stability_seconds):
    first = path.lstat()
    if not stat.S_ISREG(first.st_mode) or not 2 <= first.st_size <= 16384:
        raise ValueError('not_regular_or_invalid_size')
    if now.timestamp() - first.st_mtime < 2:
        raise ValueError('file_not_settled')
    # O_NOFOLLOW prevents a symlink substitution between lstat and open.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as handle:
        if _signature(os.fstat(handle.fileno())) != _signature(first):
            raise ValueError('file_changed')
        data = handle.read(16385)
        time.sleep(stability_seconds)
        handle.seek(0)
        again = handle.read(16385)
        if data != again or _signature(os.fstat(handle.fileno())) != _signature(first) or _signature(path.lstat()) != _signature(first):
            raise ValueError('file_changed')
    return data


def select_weather(directory, report_date, *, now=None, stability_seconds=0.25):
    valid_date(report_date)
    now = now or datetime.now(timezone.utc)
    candidates, rejected, normalization_issues = [], [], {}
    try:
        paths = sorted(Path(directory).iterdir())
    except OSError:
        return {'weather': None, 'status': 'directory_unavailable', 'rejected': []}
    for path in paths:
        match = FILENAME.fullmatch(path.name)
        if not match:
            continue
        try:
            filename_date = valid_date(match['date']).isoformat()
            if filename_date != report_date:
                raise ValueError('filename_date_mismatch')
            raw = _stable_bytes(path, now, stability_seconds)
            data = json.loads(raw.decode('utf-8-sig'), object_pairs_hook=_unique_object,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite_json')))
            diagnostics = []
            data = validate_weather(data, report_date, now, diagnostics=diagnostics)
            for code in diagnostics:
                normalization_issues[code] = normalization_issues.get(code, 0) + 1
            observed = datetime.fromisoformat(data['observed_at'])
            if match['time'] and observed.strftime('%H%M%S') != match['time']:
                raise ValueError('filename_timestamp_mismatch')
            digest = hashlib.sha256(raw).hexdigest()
            candidates.append((observed, digest, path.name, data))
        except (OSError, ValueError, TypeError, OverflowError):
            # No raw content, coordinates or health data in diagnostics.
            rejected.append(path.name)
    if not candidates:
        return {'weather': None, 'status': 'no_valid_weather', 'rejected': rejected,
                'normalization_issues': normalization_issues}
    observed, digest, name, data = max(candidates, key=lambda row: (row[0], row[1], row[2]))
    return {'weather': data, 'status': 'valid', 'filename': name, 'sha256': digest, 'rejected': rejected,
            'normalization_issues': normalization_issues}


def _degrees(value):
    return str(Decimal(str(value)).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def render_weather(weather):
    unavailable = '🌤 今日天气\n\n天气暂不可用'
    if not isinstance(weather, dict):
        return unavailable
    if any(not isinstance(weather.get(k), str) or not weather[k].strip() or any(ord(c) < 32 for c in weather[k])
           for k in ('location_name', 'condition')):
        return unavailable
    if any(type(weather.get(k)) not in (int, float) or not math.isfinite(weather[k]) or not -100 <= weather[k] <= 65
           for k in ('temperature_max_c', 'temperature_min_c')):
        return unavailable
    if weather['temperature_min_c'] > weather['temperature_max_c']:
        return unavailable
    lines = ['🌤 今日天气', '', '📍 ' + weather['location_name']]
    for field, label in (('temperature_current_c', '当前温度'),
                         ('temperature_feels_like_c', '体感温度')):
        value = weather.get(field)
        if type(value) in (int, float) and math.isfinite(value) and -100 <= value <= 65:
            lines.append(f'🌡 {label}：{_degrees(value)}℃')
    lines.extend((f'🌡 最高温：{_degrees(weather["temperature_max_c"])}℃',
                  f'❄️ 最低温：{_degrees(weather["temperature_min_c"])}℃'))
    probability = weather.get('precipitation_probability_pct')
    if type(probability) in (int, float) and math.isfinite(probability) and 0 <= probability <= 100:
        lines.append(f'🌧 今日降水概率：{_degrees(probability)}%')
    lines.append('🌧 天气：' + weather['condition'])
    return '\n'.join(lines)


def render_preview(health_text, report_date, weather):
    valid_date(report_date)
    lines = [line.strip() for line in health_text.splitlines() if line.strip()]
    if not lines or not re.fullmatch(r'\d{4}-\d{2}-\d{2} 健康晨报', lines[0]):
        raise ValueError('unsupported_stored_health_report')
    health_date = lines[0][:10]
    valid_date(health_date)
    def get(prefix):
        found = [line for line in lines[1:] if line.startswith(prefix)]
        if len(found) != 1:
            raise ValueError('missing_or_ambiguous_health_section')
        return found[0]
    sleep, structure = get('主要睡眠：'), get('睡眠结构：')
    vitals = [get(p) for p in ('睡眠心率：', '静息心率：', 'HRV SDNN：', '血氧：')]
    # Units are translated for presentation, not recalculated or substituted.
    vitals = [x.replace('count/min', '次/分').replace('HRV SDNN', '心率变异性').replace(' ms', ' 毫秒').replace(' %', '%') for x in vitals]
    note = f'记录日期：{health_date}。'
    if health_date != report_date:
        note = f'以下为 {health_date} 已存健康记录，非昨夜新采集。'
    if not isinstance(weather, dict) or weather.get('forecast_date') != report_date:
        weather = None
    # Rephrase only existing observations. No new model or clinical conclusions.
    analysis = ('这份已存报告记录了主要睡眠时长与分期，并按同一睡眠窗口整理心率、心率变异性和血氧。'
                '静息心率在主要睡眠窗口没有有效样本，沿用原报告的缺失说明，不用其他时段的数据替代。'
                '今天的安排仍可结合今晚睡前和明早的实际感受调整；以上是对既有报告的整理，没有新增健康判断。')
    # Ensure the prose's missing-metric statement is supported by the actual source.
    if '没有有效样本' not in get('静息心率：'):
        analysis = ('这份已存报告记录了主要睡眠时长与分期，并按同一睡眠窗口整理身体指标。'
                    '各项数值保留原报告中的统计范围与单位，缺失项目不使用其他时段的数据替代。'
                    '今天的安排仍可结合今晚睡前和明早的实际感受调整；以上是对既有报告的整理，没有新增健康判断。')
    return '\n\n'.join([
        f'☀️ {report_date} · 健康晨报 4.1\n你的私人健康管家',
        '🌙 昨夜睡眠\n\n' + note + '\n' + sleep + '\n' + structure.replace('REM', '快速眼动睡眠'),
        '💗 身体状态\n\n' + '\n'.join(vitals),
        render_weather(weather),
        f'🧠 Hermes 今日健康分析\n\n沿用 {health_date} 已存分析整理：\n' + analysis,
        '🌱 今天给你的建议\n\n1. 今晚提前安排休息，睡前留出放松时间。\n2. 明早留意精神与疲劳感，再安排当天活动。',
    ]) + '\n'


def save_preview(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.weather-preview-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report-date', required=True, help='Morning message local date; independent from health filename')
    parser.add_argument('--health-report', type=Path, required=True)
    parser.add_argument('--weather-dir', type=Path, default=ICLOUD_DIR)
    args = parser.parse_args()
    result = select_weather(args.weather_dir, args.report_date)
    health_bytes = args.health_report.read_bytes()
    text = render_preview(health_bytes.decode('utf-8'), args.report_date, result['weather'])
    path = PRIVATE_DIR / f'morning-brief-4.1-preview-{args.report_date}.txt'
    save_preview(path, text)
    metadata = {'report_date': args.report_date, 'weather_status': result['status'],
                'weather_file': result.get('filename'), 'weather_sha256': result.get('sha256'),
                'weather_rejected_count': len(result['rejected']),
                'health_report_sha256': hashlib.sha256(health_bytes).hexdigest(),
                'preview_sha256': hashlib.sha256(text.encode()).hexdigest(),
                'preview_path': str(path), 'model_calls': 0, 'send_calls': 0,
                'outbox_writes': 0, 'automatic_integration': False}
    save_preview(PRIVATE_DIR / f'morning-brief-4.1-preview-{args.report_date}.audit.json', json.dumps(metadata, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
