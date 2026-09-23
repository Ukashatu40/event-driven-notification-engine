// src/shared/defaults/default-preferences.ts
//
// The starter notification preferences a new account gets — every category,
// every channel, WhatsApp off (matches the schema default account type,
// BASIC — see seed.ts's bulk seeder for the same rule on a PREMIUM/HNI
// account). Shared by SignupService (a real account, created at verify time)
// and seed-me.ts (a local dev convenience for the same "give this person a
// working Preferences page" need) — one definition, not two copies to keep in sync.

const CATEGORIES = ['TXNX', 'RISK', 'SIPX', 'MKTX', 'REGX'] as const;
const CHANNELS = ['sms', 'email', 'push', 'whatsapp', 'in_app'] as const;

export interface DefaultPreferenceRow {
  userId: string;
  eventCategory: string;
  channel: string;
  enabled: boolean;
  digestMode: 'IMMEDIATE' | 'DAILY';
}

export function defaultPreferenceRows(userId: string): DefaultPreferenceRow[] {
  return CATEGORIES.flatMap((eventCategory) =>
    CHANNELS.map((channel) => ({
      userId,
      eventCategory,
      channel,
      enabled: channel !== 'whatsapp',
      digestMode: eventCategory === 'MKTX' ? 'DAILY' : 'IMMEDIATE',
    })),
  );
}
