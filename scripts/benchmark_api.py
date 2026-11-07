"""Measure read-only local queries without writing conversation content to evidence."""
import argparse, datetime, hashlib, json, pathlib, statistics, time, urllib.request, urllib.error

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://127.0.0.1:4310')
parser.add_argument('--output', default='docs/production-measurements.json')
parser.add_argument('--samples', type=int, default=5)
args = parser.parse_args()

def fetch(route):
    with urllib.request.urlopen(args.base + route, timeout=30) as response:
        raw = response.read()
        return json.loads(raw), len(raw)

health, _ = fetch('/health/ready')
storage, _ = fetch('/api/v1/storage')
counts, _ = fetch('/api/v1/overview')
routes = ['overview', 'activity/hourly', 'models', 'usage/projects', 'usage/machines', 'usage/tools',
          'projects', 'threads?limit=100', 'tool-calls?limit=100', 'tool-calls?limit=500&offset=1500',
          'model-turns?limit=500', 'storage', 'data-quality', 'search?q=test&limit=25']
measurements = []
for route in routes:
    elapsed = []
    failures = []
    digests = set()
    size = None
    for _ in range(args.samples):
        started = time.perf_counter()
        try:
            data, size = fetch('/api/v1/' + route)
        except urllib.error.HTTPError as error:
            failures.append({'status': error.code, 'elapsed_ms': (time.perf_counter() - started) * 1000})
            continue
        elapsed.append((time.perf_counter() - started) * 1000)
        # Digest only: never persist returned conversation text. Operational freshness
        # fields can change; entity routes remain comparable on a frozen database.
        digests.add(hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=True).encode()).hexdigest())
    measurements.append({'route': route, 'samples_ms': elapsed, 'failures': failures, 'response_sha256': sorted(digests), 'median_ms': statistics.median(elapsed) if elapsed else None,
                         'mean_ms': statistics.mean(elapsed) if elapsed else None, 'max_ms': max(elapsed) if elapsed else None, 'response_bytes': size})
result = {'measured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'conditions': 'Windows x64, release build, localhost HTTP+JSON, warm service; sequential requests',
          'collector_state': health.get('collector', {}).get('state'), 'storage': storage,
          'entity_counts': counts['data'], 'queries': measurements}
pathlib.Path(args.output).write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps({'queries': len(measurements), 'samples_each': args.samples,
                  'slowest_median_ms': max((x['median_ms'] for x in measurements if x['median_ms'] is not None), default=None), 'output': args.output}))
