// src/templates/engine/template-engine.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as Handlebars from 'handlebars';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PersonalisationService } from './personalisation.service';
import { SmsTruncationService } from './sms-truncation.service';
import { type SupportedLocale } from '../../shared/utils/currency.util';
import { type Channel } from '../../shared/constants/channels';

export interface TemplateDefinition {
  templateId: string;
  eventType: string;
  version: number;
  channels: {
    sms?: { body: string; senderId?: string };
    email?: { subject: string; htmlTemplate?: string; textBody?: string };
    push?: { title: string; body: string; data?: Record<string, string> };
    whatsapp?: {
      templateName: string;
      components: Array<{ type: string; parameters: string[] }>;
    };
    in_app?: { title: string; body: string; action?: string };
  };
  localisations?: Record<string, Partial<TemplateDefinition['channels']>>;
}

export interface RenderResult {
  channel: Channel;
  subject?: string;
  body: string;
  title?: string;
  data?: Record<string, unknown>;
  truncated?: boolean;
}

/**
 * Handlebars-based template engine.
 *
 * Features:
 * - Variable interpolation: {{field}}
 * - Conditional rendering: {{#if condition}}...{{/if}}
 * - Locale-aware formatting via custom helpers
 * - A/B testing via template versioning
 * - Fallback chain: locale → English → hardcoded fallback
 * - Channel-specific formatting (SMS 160 chars, push title+body, etc.)
 *
 * Templates are loaded from JSON definition files at module init.
 * Hot-reload is NOT supported in production — redeploy to update templates.
 */
@Injectable()
export class TemplateEngineService implements OnModuleInit {
  private readonly logger = new Logger(TemplateEngineService.name);
  private readonly templates = new Map<string, TemplateDefinition>();
  private readonly compiledCache = new Map<
    string,
    HandlebarsTemplateDelegate
  >();
  private readonly locales: Record<string, Record<string, string>> = {};

  constructor(
    private readonly personalisation: PersonalisationService,
    private readonly smsTruncation: SmsTruncationService,
  ) {}

  onModuleInit(): void {
    this.registerHelpers();
    this.loadLocales();
    this.loadTemplates();
    this.logger.log(
      `Template engine initialized with ${this.templates.size} templates`,
    );
  }

  async render(
    templateId: string,
    channel: Channel,
    context: Parameters<PersonalisationService['buildContext']>[0],
  ): Promise<RenderResult> {
    const template = this.getTemplate(templateId, context.language);
    const channelDef = template.channels[channel];

    if (!channelDef) {
      throw new Error(
        `Template ${templateId} has no definition for channel ${channel}`,
      );
    }

    const ctx = this.personalisation.buildContext(context);

    switch (channel) {
      case 'sms':
        return this.renderSms(
          (channelDef as TemplateDefinition['channels']['sms'])!,
          ctx,
        );
      case 'email':
        return this.renderEmail(
          (channelDef as TemplateDefinition['channels']['email'])!,
          ctx,
        );
      case 'push':
        return this.renderPush(
          (channelDef as TemplateDefinition['channels']['push'])!,
          ctx,
        );
      case 'whatsapp':
        return this.renderWhatsApp(
          (channelDef as TemplateDefinition['channels']['whatsapp'])!,
          ctx,
        );
      case 'in_app':
        return this.renderInApp(
          (channelDef as TemplateDefinition['channels']['in_app'])!,
          ctx,
        );
      default:
        throw new Error(`Unsupported channel: ${channel}`);
    }
  }

  // ── Channel renderers ─────────────────────────────────────────────

  private renderSms(
    def: NonNullable<TemplateDefinition['channels']['sms']>,
    ctx: Record<string, unknown>,
  ): RenderResult {
    const compiled = this.compile(def.body);
    const raw = compiled(ctx);
    const body = this.smsTruncation.truncate(raw);

    return {
      channel: 'sms',
      body,
      truncated: !this.smsTruncation.fits(raw),
    };
  }

  private renderEmail(
    def: NonNullable<TemplateDefinition['channels']['email']>,
    ctx: Record<string, unknown>,
  ): RenderResult {
    const subject = this.compile(def.subject)(ctx);
    const body = def.textBody ? this.compile(def.textBody)(ctx) : subject;

    return { channel: 'email', subject, body };
  }

  private renderPush(
    def: NonNullable<TemplateDefinition['channels']['push']>,
    ctx: Record<string, unknown>,
  ): RenderResult {
    const title = this.compile(def.title)(ctx);
    const body = this.compile(def.body)(ctx);

    const data: Record<string, unknown> = {};
    if (def.data) {
      for (const [key, val] of Object.entries(def.data)) {
        data[key] = this.compile(val)(ctx);
      }
    }

    return { channel: 'push', title, body, data };
  }

  private renderWhatsApp(
    def: NonNullable<TemplateDefinition['channels']['whatsapp']>,
    ctx: Record<string, unknown>,
  ): RenderResult {
    // WhatsApp uses pre-approved templates — parameters are interpolated
    const parameters = def.components.flatMap((c) =>
      c.parameters.map((p) => this.compile(p)(ctx)),
    );

    return {
      channel: 'whatsapp',
      body: parameters.join(' '),
      data: {
        templateName: def.templateName,
        components: def.components,
        resolvedParameters: parameters,
      },
    };
  }

  private renderInApp(
    def: NonNullable<TemplateDefinition['channels']['in_app']>,
    ctx: Record<string, unknown>,
  ): RenderResult {
    const title = this.compile(def.title)(ctx);
    const body = this.compile(def.body)(ctx);

    return {
      channel: 'in_app',
      title,
      body,
      data: def.action ? { action: def.action } : undefined,
    };
  }

  // ── Template loading ──────────────────────────────────────────────

  private getTemplate(
    templateId: string,
    locale: SupportedLocale,
  ): TemplateDefinition {
    const base = this.templates.get(templateId);
    if (!base) {
      throw new Error(`Template not found: ${templateId}`);
    }

    // Localisation fallback chain: requested locale → EN → base
    if (locale === 'en' || !base.localisations) return base;

    const localised = base.localisations[locale];
    if (!localised) return base;

    // Deep merge localised overrides on top of base
    return {
      ...base,
      channels: this.mergeChannels(base.channels, localised),
    };
  }

  private mergeChannels(
    base: TemplateDefinition['channels'],
    override: Partial<TemplateDefinition['channels']>,
  ): TemplateDefinition['channels'] {
    const merged = { ...base };
    for (const [channel, def] of Object.entries(override)) {
      if (def) {
        merged[channel as Channel] = {
          ...(base[channel as Channel] ?? {}),
          ...def,
        } as never;
      }
    }
    return merged;
  }

  private loadTemplates(): void {
    const definitionsDir = join(
      process.cwd(),
      'src',
      'templates',
      'definitions',
    );

    // Load all inline definitions (fallback when files not found)
    for (const def of this.getInlineTemplates()) {
      this.templates.set(def.templateId, def);
    }

    // Override with file-based definitions if they exist
    if (existsSync(definitionsDir)) {
      try {
        const files = require('fs')
          .readdirSync(definitionsDir)
          .filter((f: string) => f.endsWith('.json'));

        for (const file of files) {
          const content = readFileSync(join(definitionsDir, file), 'utf-8');
          const def = JSON.parse(content) as TemplateDefinition;
          this.templates.set(def.templateId, def);
        }

        this.logger.log(`Loaded ${files.length} templates from disk`);
      } catch (err) {
        this.logger.warn(
          `Could not load templates from disk: ${(err as Error).message}`,
        );
      }
    }
  }

  private loadLocales(): void {
    const localesDir = join(process.cwd(), 'src', 'templates', 'locales');
    const supported: SupportedLocale[] = ['en', 'hi', 'mr', 'ta', 'te'];

    for (const locale of supported) {
      const filePath = join(localesDir, `${locale}.json`);
      if (existsSync(filePath)) {
        try {
          this.locales[locale] = JSON.parse(readFileSync(filePath, 'utf-8'));
        } catch {
          this.logger.warn(`Could not load locale file: ${locale}.json`);
        }
      }
    }
  }

  // ── Handlebars helpers ────────────────────────────────────────────

  private registerHelpers(): void {
    // t: translation helper — {{t "key"}}
    Handlebars.registerHelper(
      't',
      (key: string, options: Handlebars.HelperOptions) => {
        const locale = (options.data?.root?.language as string) ?? 'en';
        return this.locales[locale]?.[key] ?? this.locales['en']?.[key] ?? key;
      },
    );

    // ifGt: {{#ifGt value threshold}}...{{/ifGt}}
    Handlebars.registerHelper(
      'ifGt',
      (a: number, b: number, options: Handlebars.HelperOptions) => {
        return a > b ? options.fn(this) : options.inverse(this);
      },
    );

    // ifEq: {{#ifEq a b}}...{{/ifEq}}
    Handlebars.registerHelper(
      'ifEq',
      (a: unknown, b: unknown, options: Handlebars.HelperOptions) => {
        return a === b ? options.fn(this) : options.inverse(this);
      },
    );

    // uppercase: {{uppercase field}}
    Handlebars.registerHelper('uppercase', (str: string) =>
      typeof str === 'string' ? str.toUpperCase() : str,
    );

    // abs: {{abs pnl_raw}} — absolute value for display
    Handlebars.registerHelper('abs', (n: number) =>
      typeof n === 'number' ? Math.abs(n) : n,
    );
  }

  private compile(template: string): HandlebarsTemplateDelegate {
    const cached = this.compiledCache.get(template);
    if (cached) return cached;

    const compiled = Handlebars.compile(template, { noEscape: false });
    this.compiledCache.set(template, compiled);
    return compiled;
  }

  // ── Inline template definitions ───────────────────────────────────

  private getInlineTemplates(): TemplateDefinition[] {
    return [
      // ── RISK-001: Margin Call Warning ─────────────────────────────
      {
        templateId: 'RISK-001-v1',
        eventType: 'RISK-001',
        version: 1,
        channels: {
          sms: {
            body: 'MARGIN CALL: Shortfall {{shortfall_amount}}. Deadline: {{deadline}}. Add funds or positions squared off at {{auto_square_off_time}}. -{{app_name}}',
            senderId: 'WLTHBR',
          },
          whatsapp: {
            templateName: 'margin_call_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{shortfall_amount}}',
                  '{{deadline}}',
                  '{{auto_square_off_time}}',
                ],
              },
            ],
          },
          push: {
            title: '⚠️ Margin Call Warning',
            body: 'Shortfall of {{shortfall_amount}}. Deadline {{deadline}}.',
            data: { action: 'open_margin_dashboard', priority: '1' },
          },
          email: {
            subject: 'URGENT: Margin Call — Action Required by {{deadline}}',
            textBody:
              'Dear {{user_name}}, your account has a margin shortfall of {{shortfall_amount}}. ' +
              'Required margin: {{required_margin}}. ' +
              'Current margin: {{current_margin}}. ' +
              'Please add funds before {{deadline}} to avoid auto square-off at {{auto_square_off_time}}.',
          },
          in_app: {
            title: 'Margin Call Warning',
            body: 'Shortfall {{shortfall_amount}} — add funds by {{deadline}}',
            action: 'open_margin_dashboard',
          },
        },
        localisations: {
          hi: {
            sms: {
              body: 'मार्जिन कॉल: कमी {{shortfall_amount}}। डेडलाइन: {{deadline}}। फंड जोड़ें या {{auto_square_off_time}} पर पोजीशन स्क्वेयर ऑफ। -{{app_name}}',
            },
            push: {
              title: '⚠️ मार्जिन कॉल चेतावनी',
              body: '{{shortfall_amount}} की कमी। डेडलाइन {{deadline}}।',
            },
          },
          mr: {
            sms: {
              body: 'मार्जिन कॉल: तूट {{shortfall_amount}}। मुदत: {{deadline}}। निधी जोडा किंवा {{auto_square_off_time}} ला स्क्वेअर ऑफ। -{{app_name}}',
            },
          },
          ta: {
            sms: {
              body: 'மார்ஜின் கால்: குறைபாடு {{shortfall_amount}}. காலக்கெடு: {{deadline}}. நிதி சேர்க்கவும். -{{app_name}}',
            },
          },
          te: {
            sms: {
              body: 'మార్జిన్ కాల్: లోటు {{shortfall_amount}}. గడువు: {{deadline}}. నిధులు జోడించండి. -{{app_name}}',
            },
          },
        },
      },

      // ── TXNX-001: Buy Order Executed ─────────────────────────────
      {
        templateId: 'TXNX-001-v1',
        eventType: 'TXNX-001',
        version: 1,
        channels: {
          sms: {
            body: '{{stock_name}} BUY: {{qty}} shares @ {{price}}. Total: {{total}}. -{{app_name}}',
            senderId: 'WLTHBR',
          },
          whatsapp: {
            templateName: 'buy_order_executed_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{stock_name}}',
                  '{{qty}}',
                  '{{price}}',
                  '{{total}}',
                ],
              },
            ],
          },
          push: {
            title: 'Buy Order Executed',
            body: '{{qty}} {{stock_name}} @ {{price}}',
            data: { action: 'open_portfolio', order_id: '{{order_id}}' },
          },
          email: {
            subject: 'Order Executed: {{qty}} {{stock_name}} @ {{price}}',
            textBody:
              'Dear {{user_name}}, your buy order has been executed. ' +
              'Stock: {{stock_name}}, Qty: {{qty}}, Price: {{price}}, Total: {{total}}.',
          },
          in_app: {
            title: 'Buy Order Executed',
            body: '{{qty}} {{stock_name}} @ {{price}} — Total {{total}}',
            action: 'open_portfolio',
          },
        },
        localisations: {
          hi: {
            sms: {
              body: '{{stock_name}} खरीद: {{qty}} शेयर @ {{price}}। कुल: {{total}}। -{{app_name}}',
            },
          },
        },
      },

      // ── TXNX-002: Sell Order Executed ────────────────────────────
      {
        templateId: 'TXNX-002-v1',
        eventType: 'TXNX-002',
        version: 1,
        channels: {
          sms: {
            body: '{{stock_name}} SELL: {{qty}} shares @ {{price}}. P&L: {{pnl}}. -{{app_name}}',
            senderId: 'WLTHBR',
          },
          whatsapp: {
            templateName: 'sell_order_executed_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{stock_name}}',
                  '{{qty}}',
                  '{{price}}',
                  '{{pnl}}',
                ],
              },
            ],
          },
          push: {
            title: 'Sell Order Executed',
            body: '{{qty}} {{stock_name}} @ {{price}} | P&L: {{pnl}}',
            data: { action: 'open_portfolio' },
          },
          email: {
            subject: 'Sell Order Executed: {{qty}} {{stock_name}} @ {{price}}',
            textBody:
              'Sell order executed. Stock: {{stock_name}}, Qty: {{qty}}, ' +
              'Price: {{price}}, P&L: {{pnl}}.',
          },
          in_app: {
            title: 'Sell Order Executed',
            body: '{{qty}} {{stock_name}} @ {{price}} | P&L {{pnl}}',
          },
        },
      },

      // ── TXNX-003: Order Rejected ──────────────────────────────────
      {
        templateId: 'TXNX-003-v1',
        eventType: 'TXNX-003',
        version: 1,
        channels: {
          sms: {
            body: 'Order REJECTED: {{stock_name}} — {{reason}}. -{{app_name}}',
          },
          whatsapp: {
            templateName: 'order_rejected_v1',
            components: [
              {
                type: 'body',
                parameters: ['{{stock_name}}', '{{reason}}'],
              },
            ],
          },
          email: {
            subject: 'Order Rejected: {{stock_name}}',
            textBody:
              'Dear {{user_name}}, your order for {{stock_name}} was rejected. ' +
              'Reason: {{reason}}. Please review and resubmit if needed.',
          },
          push: {
            title: 'Order Rejected',
            body: '{{stock_name}} order rejected: {{reason}}',
            data: { action: 'open_orders' },
          },
          in_app: {
            title: 'Order Rejected',
            body: '{{stock_name}} — {{reason}}',
            action: 'open_orders',
          },
        },
      },

      // ── RISK-002: Margin Shortfall ────────────────────────────────
      {
        templateId: 'RISK-002-v1',
        eventType: 'RISK-002',
        version: 1,
        channels: {
          sms: {
            body: 'URGENT: Margin shortfall {{shortfall_amount}}. Auto square-off at {{auto_square_off_time}}. Add funds NOW. -{{app_name}}',
          },
          whatsapp: {
            templateName: 'margin_shortfall_urgent_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{shortfall_amount}}',
                  '{{auto_square_off_time}}',
                ],
              },
            ],
          },
          push: {
            title: '🚨 Margin Shortfall',
            body: 'Auto square-off at {{auto_square_off_time}}. Add {{shortfall_amount}} NOW.',
            data: { action: 'open_margin_dashboard', priority: '1' },
          },
          email: {
            subject: '🚨 URGENT: Margin Shortfall — Auto Square-off Imminent',
            textBody:
              'URGENT: Your account has a margin shortfall of {{shortfall_amount}}. ' +
              'Auto square-off will occur at {{auto_square_off_time}} if not resolved.',
          },
          in_app: {
            title: '🚨 Margin Shortfall',
            body: 'Add funds immediately. Auto square-off at {{auto_square_off_time}}.',
            action: 'open_margin_dashboard',
          },
        },
        localisations: {
          hi: {
            sms: {
              body: 'जरूरी: मार्जिन कमी {{shortfall_amount}}। {{auto_square_off_time}} पर ऑटो स्क्वेयर ऑफ। अभी फंड जोड़ें। -{{app_name}}',
            },
          },
        },
      },

      // ── MKTX-001: Price Alert ─────────────────────────────────────
      {
        templateId: 'MKTX-001-v1',
        eventType: 'MKTX-001',
        version: 1,
        channels: {
          sms: {
            body: 'Price Alert: {{stock_name}} {{direction}} {{current_price}} (target: {{target_price}}). -{{app_name}}',
          },
          whatsapp: {
            templateName: 'price_alert_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{stock_name}}',
                  '{{direction}}',
                  '{{current_price}}',
                  '{{target_price}}',
                ],
              },
            ],
          },
          email: {
            subject:
              'Price Alert: {{stock_name}} {{direction}} {{target_price}}',
            textBody:
              'Dear {{user_name}}, {{stock_name}} has moved {{direction}} your target of {{target_price}}. ' +
              'Current price: {{current_price}}.',
          },
          push: {
            title: '📈 Price Alert: {{stock_name}}',
            body: '{{stock_name}} hit {{current_price}} | Target: {{target_price}}',
            data: { action: 'open_stock', symbol: '{{symbol}}' },
          },
          in_app: {
            title: 'Price Alert',
            body: '{{stock_name}} — {{current_price}} ({{direction}} target {{target_price}})',
            action: 'open_stock',
          },
        },
      },

      // ── MKTX-002: Circuit Breaker ─────────────────────────────────
      {
        templateId: 'MKTX-002-v1',
        eventType: 'MKTX-002',
        version: 1,
        channels: {
          sms: {
            body: 'Circuit Breaker: {{stock_name}} trading halted. Level {{circuit_level}}. Resumes: {{resume_time}}. -{{app_name}}',
          },
          whatsapp: {
            templateName: 'circuit_breaker_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{stock_name}}',
                  '{{circuit_level}}',
                  '{{resume_time}}',
                ],
              },
            ],
          },
          email: {
            subject: 'Circuit Breaker: {{stock_name}} Trading Halted',
            textBody:
              'Dear {{user_name}}, trading in {{stock_name}} has been halted due to a circuit breaker ' +
              'at level {{circuit_level}}. Trading is expected to resume at {{resume_time}}.',
          },
          push: {
            title: '⛔ Circuit Breaker: {{stock_name}}',
            body: 'Trading halted at {{circuit_level}}. Resumes {{resume_time}}.',
            data: { action: 'open_stock', symbol: '{{symbol}}' },
          },
          in_app: {
            title: 'Circuit Breaker Hit',
            body: '{{stock_name}} halted at {{circuit_level}}. Resumes {{resume_time}}.',
          },
        },
      },

      // ── SIPX-001: SIP Reminder ────────────────────────────────────
      {
        templateId: 'SIPX-001-v1',
        eventType: 'SIPX-001',
        version: 1,
        channels: {
          sms: {
            body: 'SIP Reminder: {{fund_name}} {{amount}} due {{due_date}}. Ensure sufficient balance. -{{app_name}}',
            senderId: 'WLTHBR',
          },
          email: {
            subject: 'SIP Payment Reminder: {{fund_name}}',
            textBody:
              'Dear {{user_name}}, your SIP of {{amount}} for {{fund_name}} is due on {{due_date}}. ' +
              'Please ensure sufficient balance in your linked account.',
          },
          push: {
            title: 'SIP Due Reminder',
            body: '{{fund_name}} SIP of {{amount}} due on {{sip_date}}',
            data: { action: 'open_sip' },
          },
          whatsapp: {
            templateName: 'sip_reminder_v1',
            components: [
              {
                type: 'body',
                parameters: ['{{fund_name}}', '{{amount}}', '{{sip_date}}'],
              },
            ],
          },
          in_app: {
            title: 'SIP Due Soon',
            body: '{{fund_name}} — {{amount}} due {{sip_date}}',
            action: 'open_sip',
          },
        },
      },

      // ── SIPX-002: SIP Executed ────────────────────────────────────
      {
        templateId: 'SIPX-002-v1',
        eventType: 'SIPX-002',
        version: 1,
        channels: {
          sms: {
            body: 'SIP Executed: {{fund_name}} {{amount}}. Units: {{units_allotted}} @ NAV {{nav}}. -{{app_name}}',
          },
          whatsapp: {
            templateName: 'sip_executed_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{fund_name}}',
                  '{{amount}}',
                  '{{units_allotted}}',
                  '{{nav}}',
                ],
              },
            ],
          },
          email: {
            subject: 'SIP Executed: {{fund_name}}',
            textBody:
              'Your SIP has been executed. Fund: {{fund_name}}, Amount: {{amount}}, ' +
              'Units allotted: {{units_allotted}}, NAV: {{nav}}.',
          },
          push: {
            title: '✅ SIP Executed',
            body: '{{fund_name}}: {{units_allotted}} units @ NAV {{nav}}',
            data: { action: 'open_portfolio' },
          },
          in_app: {
            title: 'SIP Executed',
            body: '{{fund_name}} — {{units_allotted}} units @ NAV {{nav}}',
          },
        },
      },

      // ── REGX-001: KYC Expiry Warning ──────────────────────────────
      {
        templateId: 'REGX-001-v1',
        eventType: 'REGX-001',
        version: 1,
        channels: {
          sms: {
            body: 'KYC expires {{expiry_date}}. Complete renewal to avoid account restrictions. -{{app_name}}',
          },
          whatsapp: {
            templateName: 'kyc_expiry_v1',
            components: [
              {
                type: 'body',
                parameters: ['{{expiry_date}}', '{{documents_needed}}'],
              },
            ],
          },
          email: {
            subject: 'Action Required: KYC Expiry on {{expiry_date}}',
            textBody:
              'Dear {{user_name}}, your KYC expires on {{expiry_date}}. ' +
              'Documents needed: {{documents_needed}}. ' +
              'Please complete renewal to avoid account restrictions.',
          },
          push: {
            title: 'KYC Expiry Reminder',
            body: 'KYC expires {{expiry_date}}. Tap to renew.',
            data: { action: 'open_kyc' },
          },
          in_app: {
            title: 'KYC Expiry Warning',
            body: 'Your KYC expires on {{expiry_date}}. Complete renewal now.',
            action: 'open_kyc',
          },
        },
      },

      // ── REGX-005: Regulatory Policy Change ───────────────────────
      {
        templateId: 'REGX-005-v1',
        eventType: 'REGX-005',
        version: 1,
        channels: {
          sms: {
            body: 'Regulatory Update: {{change_summary}}. Effective {{effective_date}}. -{{app_name}}',
          },
          push: {
            title: '📋 Regulatory Update',
            body: '{{change_summary}} — effective {{effective_date}}',
            data: { action: 'open_notices' },
          },
          email: {
            subject: 'Regulatory Update: {{change_summary}}',
            textBody:
              'Dear {{user_name}}, there has been a regulatory change: {{change_summary}}. ' +
              'Impact on your account: {{impact}}. Effective date: {{effective_date}}.',
          },
          whatsapp: {
            templateName: 'regulatory_update_v1',
            components: [
              {
                type: 'body',
                parameters: ['{{change_summary}}', '{{effective_date}}'],
              },
            ],
          },
          in_app: {
            title: 'Regulatory Update',
            body: '{{change_summary}} — effective {{effective_date}}',
            action: 'open_regulatory_updates',
          },
        },
      },
    ];
  }
}
