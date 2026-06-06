export const CHANNELS = {
  SMS: 'sms',
  EMAIL: 'email',
  PUSH: 'push',
  WHATSAPP: 'whatsapp',
  IN_APP: 'in_app',
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

export const ALL_CHANNELS: Channel[] = Object.values(CHANNELS);

// Cost per message in paisa (100 paisa = ₹1)
export const CHANNEL_COST_PAISA: Record<Channel, number> = {
  sms: 20, // ₹0.20 avg
  email: 3, // ₹0.03 avg
  push: 0, // Free (FCM)
  whatsapp: 55, // ₹0.55 avg
  in_app: 0, // Free
};

// Delivery rate estimates for scoring (0-1)
export const CHANNEL_DELIVERY_RATE: Record<Channel, number> = {
  sms: 0.97,
  email: 0.9,
  push: 0.7,
  whatsapp: 0.93,
  in_app: 0.99,
};
