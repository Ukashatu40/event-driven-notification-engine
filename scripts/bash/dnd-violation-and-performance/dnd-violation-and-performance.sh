python3 << 'PYEOF'
import csv, random
from datetime import datetime, timedelta

random.seed(42)
base = datetime(2025, 12, 1)

# dnd_violations.csv — 12,847 records per spec Section B1.2
with open('data/dnd_violations.csv', 'w', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=[
        'violation_id', 'user_id', 'phone', 'notification_id', 'event_type',
        'channel', 'dnd_category', 'message_classification', 'detected_at',
        'root_cause', 'provider', 'resolved', 'resolution'
    ])
    writer.writeheader()
    causes = ['STALE_DND_CACHE', 'RACE_CONDITION', 'WRONG_CLASSIFICATION', 'MISSING_SCRUB']
    event_types = ['MKTX-001','MKTX-003','MKTX-004','MKTX-005','SIPX-004']
    for i in range(12847):
        offset = timedelta(days=random.randint(0, 89), hours=random.randint(0,23), minutes=random.randint(0,59))
        writer.writerow({
            'violation_id': f'VIO-{i+1:05d}',
            'user_id': f'user-{random.randint(1, 10000)}',
            'phone': f'+9190{random.randint(10000000, 99999999)}',
            'notification_id': f'ntf-{i+1:05d}-vio',
            'event_type': random.choice(event_types),
            'channel': 'sms',
            'dnd_category': 'BANKING_INSURANCE_FINANCIAL_PRODUCTS',
            'message_classification': 'PROMOTIONAL',
            'detected_at': (base + offset).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'root_cause': random.choice(causes),
            'provider': random.choice(['msg91', 'twilio']),
            'resolved': random.choice(['true', 'false']),
            'resolution': random.choice(['DND_CHECK_MOVED_TO_DISPATCH', 'CLASSIFICATION_FIXED', 'CACHE_TTL_REDUCED', '']),
        })

print("dnd_violations.csv: 12847 rows written")

# delivery_performance.csv — 90 days of per-provider metrics per spec Section B1.2
with open('data/delivery_performance.csv', 'w', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=[
        'date', 'channel', 'provider', 'total_sent', 'total_delivered',
        'total_failed', 'delivery_rate', 'p50_latency_ms', 'p95_latency_ms',
        'p99_latency_ms', 'cost_inr', 'circuit_opens', 'avg_retry_count'
    ])
    writer.writeheader()
    providers = [
        ('sms', 'msg91'), ('sms', 'twilio'),
        ('email', 'nodemailer'), ('push', 'fcm'),
        ('whatsapp', 'whatsapp_cloud'), ('in_app', 'internal')
    ]
    for day in range(90):
        date = (base + timedelta(days=day)).strftime('%Y-%m-%d')
        is_weekend = (base + timedelta(days=day)).weekday() >= 5
        for channel, provider in providers:
            volume_mult = 0.4 if is_weekend else 1.0
            base_volume = {'sms': 15000, 'email': 12000, 'push': 22000,
                           'whatsapp': 9000, 'in_app': 8000}.get(channel, 5000)
            sent = int(base_volume * volume_mult * random.uniform(0.85, 1.15))
            dr = {'sms': 0.96, 'email': 0.91, 'push': 0.76, 'whatsapp': 0.93, 'in_app': 0.999}.get(channel, 0.9)
            delivered = int(sent * dr * random.uniform(0.97, 1.03))
            failed = sent - delivered
            writer.writerow({
                'date': date, 'channel': channel, 'provider': provider,
                'total_sent': sent, 'total_delivered': delivered, 'total_failed': failed,
                'delivery_rate': round(delivered / sent, 4),
                'p50_latency_ms': int(random.uniform(800, 3000)),
                'p95_latency_ms': int(random.uniform(4000, 12000)),
                'p99_latency_ms': int(random.uniform(15000, 45000)),
                'cost_inr': round(sent * {'sms': 0.0020, 'email': 0.0003, 'push': 0,
                                          'whatsapp': 0.0050, 'in_app': 0, 'call': 0.025}.get(channel, 0), 2),
                'circuit_opens': random.randint(0, 3) if random.random() < 0.05 else 0,
                'avg_retry_count': round(random.uniform(0.02, 0.15), 3),
            })

print("delivery_performance.csv: 90 days x 6 providers =", 90*6, "rows written")
PYEOF