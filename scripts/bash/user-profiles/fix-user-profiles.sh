#!/bin/bash

python3 << 'PYEOF'
import csv, json, random
from datetime import datetime, timedelta

input_file = 'data/user_profiles.csv'
output_file = 'data/user_profiles_new.csv'

DND_CATEGORIES = ['', 'BANKING', 'BANKING,INSURANCE', 'FINANCIAL_PRODUCTS', 'BANKING,FINANCIAL_PRODUCTS', 'INSURANCE']
CHANNELS = ['sms', 'email', 'push', 'whatsapp', 'in_app']
CATEGORIES = ['TXNX', 'RISK', 'SIPX', 'MKTX', 'REGX']

def make_notification_preferences(row):
    """Generate realistic per-category channel preferences."""
    prefs = {}
    for cat in CATEGORIES:
        prefs[cat] = {
            'channels': {c: random.random() > 0.3 for c in CHANNELS},
            'digest_mode': random.choice(['immediate', 'hourly', 'daily']),
        }
    return json.dumps(prefs)

def make_dnd_categories(dnd_status):
    if dnd_status == 'registered':
        return random.choice(DND_CATEGORIES[1:])  # non-empty
    return ''

base_date = datetime(2024, 1, 1)

with open(input_file, 'r') as infile, open(output_file, 'w', newline='') as outfile:
    reader = csv.DictReader(infile)
    # Spec B4.1 required fields:
    # user_id, name, phone, email, language, timezone, dnd_status, dnd_categories,
    # account_type, risk_profile, notification_preferences, quiet_hours_start, quiet_hours_end, created_at
    fieldnames = [
        'user_id', 'name', 'phone', 'email', 'language', 'timezone',
        'dnd_status', 'dnd_categories', 'account_type', 'risk_profile',
        'notification_preferences', 'quiet_hours_start', 'quiet_hours_end', 'created_at'
    ]
    writer = csv.DictWriter(outfile, fieldnames=fieldnames, extrasaction='ignore')
    writer.writeheader()
    count = 0
    random.seed(42)
    for row in reader:
        row['dnd_categories'] = make_dnd_categories(row.get('dnd_status', ''))
        row['notification_preferences'] = make_notification_preferences(row)
        # created_at: random date between 2024-01-01 and 2025-12-31
        offset_days = random.randint(0, 730)
        row['created_at'] = (base_date + timedelta(days=offset_days)).strftime('%Y-%m-%dT%H:%M:%SZ')
        writer.writerow(row)
        count += 1

print(f"Written {count} rows")
PYEOF
