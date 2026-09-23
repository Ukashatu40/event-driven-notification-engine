// src/templates/definitions/ng-localisations.ts

/**
 * Nigerian-language content for the templates that matter most to a Nigerian
 * user: margin call (RISK-001), margin shortfall (RISK-002), buy order
 * executed (TXNX-001) and funds deposited (TXNX-005).
 *
 * Locales: pcm (Nigerian Pidgin), ha (Hausa), yo (Yoruba), ig (Igbo).
 * Any locale or channel not listed falls back to the English template.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ DRAFT TRANSLATIONS — must be reviewed by native speakers (ideally one  │
 * │ with financial-services experience) before production use. Margin-call │
 * │ wording in particular has real money consequences.                     │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * SMS bodies are deliberately written WITHOUT diacritics / hooked letters
 * (ẹ ọ ṣ ị ụ ɓ ɗ ƙ …): those characters are outside the GSM-7 alphabet and
 * would drop the SMS limit from 160 to 70 characters (see SmsTruncationService),
 * roughly doubling cost and splitting the message. Push and in-app text are
 * not size-constrained the same way and use proper orthography.
 */
type ChannelOverrides = Record<string, Record<string, string>>;
type LocaleOverrides = Record<string, ChannelOverrides>;

export const NG_LOCALISATIONS: Record<string, LocaleOverrides> = {
  'DIGEST-v1': {
    pcm: {
      push: { title: 'You get {{count}} updates from {{app_name}}' },
      in_app: { title: 'You get {{count}} updates' },
    },
    ha: {
      push: { title: 'Kuna da sabbin bayanai {{count}} daga {{app_name}}' },
      in_app: { title: 'Sabbin bayanai {{count}}' },
    },
    yo: {
      push: { title: 'O ní ìmúdójúìwọ̀n {{count}} láti {{app_name}}' },
      in_app: { title: 'Ìmúdójúìwọ̀n {{count}}' },
    },
    ig: {
      push: { title: 'Ị nwere ozi ọhụrụ {{count}} si {{app_name}}' },
      in_app: { title: 'Ozi ọhụrụ {{count}}' },
    },
  },

  'RISK-001-v1': {
    pcm: {
      sms: {
        body: 'MARGIN CALL: Your account short by {{shortfall_amount}}. Deadline: {{deadline}}. Abeg add money, if not dem fit sell your positions by {{auto_square_off_time}}. -{{app_name}}',
      },
      push: {
        title: '⚠️ Margin Call Warning',
        body: '{{shortfall_amount}} short. Deadline {{deadline}}.',
      },
    },
    ha: {
      sms: {
        body: "MARGIN CALL: Kuna da gibin {{shortfall_amount}}. Wa'adi: {{deadline}}. Ku kara kudi, in ba haka ba za a sayar da hannun jarinku da {{auto_square_off_time}}. -{{app_name}}",
      },
      push: {
        title: '⚠️ Gargadin Margin Call',
        body: "Gibin {{shortfall_amount}}. Wa'adi {{deadline}}.",
      },
    },
    yo: {
      sms: {
        body: 'MARGIN CALL: Aito re je {{shortfall_amount}}. Akoko ipari: {{deadline}}. Jowo fi owo kun, bi ko se be, a o ta awon ipo re ni {{auto_square_off_time}}. -{{app_name}}',
      },
      push: {
        title: '⚠️ Ìkìlọ̀ Margin Call',
        body: 'Àìtó {{shortfall_amount}}. Àkókò ìparí {{deadline}}.',
      },
    },
    ig: {
      sms: {
        body: 'MARGIN CALL: Ego gi adighi eru site na {{shortfall_amount}}. Oge ikpeazu: {{deadline}}. Biko tinye ego, ma o bu na a ga-ere ihe i nwere na {{auto_square_off_time}}. -{{app_name}}',
      },
      push: {
        title: '⚠️ Ọkwa Margin Call',
        body: 'Ego adịghị eru: {{shortfall_amount}}. Oge ikpeazu {{deadline}}.',
      },
    },
  },

  'RISK-002-v1': {
    pcm: {
      sms: {
        body: 'MARGIN SHORTFALL: Your account short by {{shortfall_amount}}. Add money before {{auto_square_off_time}} or dem go sell your positions. -{{app_name}}',
      },
    },
    ha: {
      sms: {
        body: 'GIBIN MARGIN: Kuna da gibin {{shortfall_amount}}. Ku kara kudi kafin {{auto_square_off_time}} ko a sayar da hannun jarinku. -{{app_name}}',
      },
    },
    yo: {
      sms: {
        body: 'AITO MARGIN: Aito re je {{shortfall_amount}}. Fi owo kun saaju {{auto_square_off_time}} tabi ki a ta awon ipo re. -{{app_name}}',
      },
    },
    ig: {
      sms: {
        body: 'EGO MARGIN ADIGHI ERU: {{shortfall_amount}}. Tinye ego tupu {{auto_square_off_time}} ma o bu na a ga-ere ihe i nwere. -{{app_name}}',
      },
    },
  },

  'TXNX-001-v1': {
    pcm: {
      sms: {
        body: '{{stock_name}} BUY don enter: {{qty}} shares @ {{price}}. Total: {{total}}. -{{app_name}}',
      },
      push: {
        title: 'Your buy don enter',
        body: '{{qty}} {{stock_name}} @ {{price}}',
      },
    },
    ha: {
      sms: {
        body: 'An sayi {{stock_name}}: hannun jari {{qty}} @ {{price}}. Jimla: {{total}}. -{{app_name}}',
      },
      push: {
        title: 'An sayi hannun jari',
        body: '{{qty}} {{stock_name}} @ {{price}}',
      },
    },
    yo: {
      sms: {
        body: 'Rira {{stock_name}} ti pari: ipin {{qty}} @ {{price}}. Apapo: {{total}}. -{{app_name}}',
      },
      push: {
        title: 'Ríra ti parí',
        body: '{{qty}} {{stock_name}} @ {{price}}',
      },
    },
    ig: {
      sms: {
        body: 'Ire ahia {{stock_name}} agwula: oke {{qty}} @ {{price}}. Ngukota: {{total}}. -{{app_name}}',
      },
      push: {
        title: 'Ịzụrụ agwụla',
        body: '{{qty}} {{stock_name}} @ {{price}}',
      },
    },
  },

  'TXNX-005-v1': {
    pcm: {
      sms: {
        body: 'Money don enter: {{amount}} from {{source}}. {{#if available_balance}}Your balance na {{available_balance}}. {{/if}}-{{app_name}}',
      },
      push: {
        title: '✅ Money don enter',
        body: '{{amount}} enter.{{#if available_balance}} Balance: {{available_balance}}{{/if}}',
      },
    },
    ha: {
      sms: {
        body: 'An saka kudi: {{amount}} daga {{source}}. {{#if available_balance}}Ragowar ku: {{available_balance}}. {{/if}}-{{app_name}}',
      },
      push: {
        title: '✅ An saka kuɗi',
        body: '{{amount}} ya shiga.{{#if available_balance}} Ragowa: {{available_balance}}{{/if}}',
      },
    },
    yo: {
      sms: {
        body: 'Owo wole: {{amount}} lati {{source}}. {{#if available_balance}}Iyoku re: {{available_balance}}. {{/if}}-{{app_name}}',
      },
      push: {
        title: '✅ Owó wọlé',
        body: '{{amount}} wọlé.{{#if available_balance}} Ìyókù: {{available_balance}}{{/if}}',
      },
    },
    ig: {
      sms: {
        body: 'Ego batara: {{amount}} si {{source}}. {{#if available_balance}}Ego fodura gi: {{available_balance}}. {{/if}}-{{app_name}}',
      },
      push: {
        title: '✅ Ego batara',
        body: '{{amount}} batara.{{#if available_balance}} Ego fọdụrụ: {{available_balance}}{{/if}}',
      },
    },
  },
};
