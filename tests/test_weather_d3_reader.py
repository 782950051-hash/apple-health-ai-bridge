import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from weather_d3_reader import read_candidates


class ReaderTests(unittest.TestCase):
    def test_stable_current_candidates_and_reject_corruption(self):
        now = datetime.fromisoformat('2026-11-03T08:03:00+08:00')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def put(stamp, **changes):
                data = dict(schema_version='1.0', source='apple_weather_shortcuts',
                            observed_at=stamp, forecast_date=stamp[:10], location_name='测试城市',
                            temperature_max_c=22.19, temperature_min_c=16.57, condition='微雨')
                data.update(changes)
                path = root / ('weather-' + datetime.fromisoformat(stamp).strftime('%Y-%m-%d-%H%M%S') + '.json')
                path.write_text(json.dumps(data))
                os.utime(path, (now.timestamp()-10,)*2)
                return path
            put('2026-11-03T08:00:00+08:00')
            put('2026-11-03T08:01:00+08:00')
            put('2026-11-02T08:00:00+08:00')
            put('2026-11-03T08:02:00+08:00', temperature_max_c='22')
            put('2026-11-03T08:02:01+08:00').write_text('{')
            put('2026-11-03T08:02:02+08:00')  # mtime unsettled
            os.utime(root/'weather-2026-11-03-080202.json', (now.timestamp(),)*2)
            (root/'health-untouched.json').write_text('original')
            result = read_candidates(root, now=now, stability_seconds=0)
            self.assertEqual(len(result['records']), 2)
            self.assertEqual(result['rejected_count'], 4)
            self.assertEqual(result['records'][0]['weather']['temperature_max_c'], 22.19)
            self.assertEqual(len(result['records'][0]['sha256']), 64)
            self.assertEqual((root/'health-untouched.json').read_text(), 'original')

    def test_offset_local_day_independent_of_mac(self):
        now = datetime.fromisoformat('2026-11-03T00:03:00+14:00')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p = root/'weather-2026-11-03-000000.json'
            p.write_text(json.dumps(dict(schema_version='1.0', source='apple_weather_shortcuts',
                observed_at='2026-11-03T00:00:00+14:00', forecast_date='2026-11-03',
                location_name='测试城市', temperature_max_c=20, temperature_min_c=10, condition='晴')))
            os.utime(p, (now.timestamp()-10,)*2)
            self.assertEqual(len(read_candidates(root, now=now, stability_seconds=0)['records']), 1)

    def test_fixed_date_name_and_legacy_timestamp_name_are_both_read(self):
        now = datetime.fromisoformat('2026-11-03T08:05:00+08:00')
        data = dict(schema_version='1.0', source='apple_weather_shortcuts',
                    observed_at='2026-11-03T08:00:00+08:00', forecast_date='2026-11-03',
                    location_name='隔离城市', temperature_max_c=22.19,
                    temperature_min_c=16.57, condition='微雨')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('weather-2026-11-03.json', 'weather-2026-11-03-080000.json'):
                path = root / name
                path.write_text(json.dumps(data, ensure_ascii=False))
                os.utime(path, (now.timestamp()-10,)*2)
            result = read_candidates(root, now=now, stability_seconds=0)
            self.assertEqual({row['filename'] for row in result['records']},
                             {'weather-2026-11-03.json', 'weather-2026-11-03-080000.json'})
            self.assertEqual(len({row['sha256'] for row in result['records']}), 1)

    def test_fixed_name_requires_strict_date_match_and_valid_json(self):
        now = datetime.fromisoformat('2026-11-03T08:05:00+08:00')
        data = dict(schema_version='1.0', source='apple_weather_shortcuts',
                    observed_at='2026-11-03T08:00:00+08:00', forecast_date='2026-11-03',
                    location_name='隔离城市', temperature_max_c=22.19,
                    temperature_min_c=16.57, condition='微雨')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            mismatch = root / 'weather-2026-11-04.json'
            mismatch.write_text(json.dumps(data))
            malformed = root / 'weather-2026-11-03-080001.json'
            malformed.write_text('{')
            invalid_date = root / 'weather-2026-02-30.json'
            invalid_date.write_text(json.dumps(data))
            for path in (mismatch, malformed, invalid_date):
                os.utime(path, (now.timestamp()-10,)*2)
            result = read_candidates(root, now=now, stability_seconds=0)
            self.assertEqual(result['records'], [])
            self.assertEqual(result['rejected_count'], 3)

    def test_fixed_name_content_update_changes_digest_without_path_cache(self):
        now = datetime.fromisoformat('2026-11-03T08:05:00+08:00')
        base = dict(schema_version='1.0', source='apple_weather_shortcuts',
                    observed_at='2026-11-03T08:00:00+08:00', forecast_date='2026-11-03',
                    location_name='地区甲', temperature_max_c=22.19,
                    temperature_min_c=16.57, condition='微雨')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / 'weather-2026-11-03.json'
            path.write_text(json.dumps(base, ensure_ascii=False))
            os.utime(path, (now.timestamp()-10,)*2)
            first = read_candidates(root, now=now, stability_seconds=0)['records'][0]
            updated = dict(base, observed_at='2026-11-03T08:01:00+08:00', location_name='地区乙')
            path.write_text(json.dumps(updated, ensure_ascii=False))
            os.utime(path, (now.timestamp()-5,)*2)
            second = read_candidates(root, now=now, stability_seconds=0)['records'][0]
            self.assertNotEqual(first['sha256'], second['sha256'])
            self.assertEqual(second['weather']['location_name'], '地区乙')

    def test_optional_metrics_round_trip_and_probability_is_canonical_percent(self):
        now = datetime.fromisoformat('2026-11-03T08:05:00+08:00')
        data = dict(schema_version='1.0', source='apple_weather_shortcuts',
                    observed_at='2026-11-03T08:00:00+08:00', forecast_date='2026-11-03',
                    location_name='隔离城市', temperature_max_c=22.19,
                    temperature_min_c=16.57, condition='微雨', temperature_current_c=19.2,
                    temperature_feels_like_c=17.8, precipitation_probability_pct=65)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / 'weather-2026-11-03.json'
            path.write_text(json.dumps(data, ensure_ascii=False))
            os.utime(path, (now.timestamp()-10,)*2)
            result = read_candidates(root, now=now, stability_seconds=0)
            self.assertEqual(result['records'][0]['weather']['temperature_current_c'], 19.2)
            self.assertEqual(result['records'][0]['weather']['precipitation_probability_pct'], 65)

            data['precipitation_probability_pct'] = 101
            path.write_text(json.dumps(data, ensure_ascii=False))
            os.utime(path, (now.timestamp()-5,)*2)
            invalid = read_candidates(root, now=now, stability_seconds=0)
            self.assertEqual(invalid['records'], [])
            self.assertEqual(invalid['rejected_count'], 1)

    def test_raw_fields_normalize_explicit_units_and_daily_chance_fraction(self):
        now = datetime.fromisoformat('2026-11-03T08:05:00+08:00')
        data = dict(schema_version='1.0', source='apple_weather_shortcuts',
                    observed_at='2026-11-03T08:00:00+08:00', forecast_date='2026-11-03',
                    location_name='隔离城市', temperature_max_c=22.19,
                    temperature_min_c=16.57, condition='微雨',
                    temperature_current_raw='68°F',
                    temperature_current_source='apple_weather_current_conditions.temperature',
                    temperature_current_raw_unit='embedded',
                    temperature_current_raw_type='shortcuts_text',
                    temperature_feels_like_raw='18°C',
                    temperature_feels_like_source='apple_weather_current_conditions.feels_like',
                    temperature_feels_like_raw_unit='embedded',
                    temperature_feels_like_raw_type='shortcuts_text',
                    precipitation_probability_raw='0.4',
                    precipitation_probability_source='apple_weather_daily_forecast.precipitation_chance',
                    precipitation_probability_raw_unit='embedded',
                    precipitation_probability_raw_type='shortcuts_text')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / 'weather-2026-11-03.json'
            path.write_text(json.dumps(data, ensure_ascii=False))
            os.utime(path, (now.timestamp()-10,)*2)
            result = read_candidates(root, now=now, stability_seconds=0)
            weather = result['records'][0]['weather']
            self.assertAlmostEqual(weather['temperature_current_c'], 20)
            self.assertEqual(weather['temperature_feels_like_c'], 18)
            self.assertEqual(weather['precipitation_probability_pct'], 40)
            self.assertEqual(result['normalization_issues'], {})


if __name__ == '__main__': unittest.main()
