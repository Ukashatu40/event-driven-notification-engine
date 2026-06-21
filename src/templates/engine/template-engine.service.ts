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

      // ── TXNX-004: Dividend Credited ───────────────────────────────
      {
        templateId: 'TXNX-004-v1',
        eventType: 'TXNX-004',
        version: 1,
        channels: {
          email: {
            subject: 'Dividend Credited: {{company}} — {{amount}}',
            textBody:
              'Dear {{user_name}}, a dividend of {{amount}} from {{company}} has been credited to your account. ' +
              'Record date: {{record_date}}. Account: {{bank_account}}.',
          },
          push: {
            title: '💰 Dividend Credited',
            body: '{{company}}: {{amount}} credited',
            data: { action: 'open_portfolio' },
          },
          in_app: {
            title: 'Dividend Credited',
            body: '{{company}} — {{amount}} credited on {{record_date}}',
            action: 'open_portfolio',
          },
          whatsapp: {
            templateName: 'dividend_credited_v1',
            components: [
              {
                type: 'body',
                parameters: ['{{company}}', '{{amount}}', '{{record_date}}'],
              },
            ],
          },
        },
      },

      // ── TXNX-005: Funds Deposited ─────────────────────────────────
      {
        templateId: 'TXNX-005-v1',
        eventType: 'TXNX-005',
        version: 1,
        channels: {
          sms: {
            body: 'Funds Deposited: {{amount}} from {{source}}. Available balance: {{available_balance}}. -{{app_name}}',
            senderId: 'WLTHBR',
          },
          push: {
            title: '✅ Funds Deposited',
            body: '{{amount}} credited. Balance: {{available_balance}}',
            data: { action: 'open_wallet' },
          },
          in_app: {
            title: 'Funds Deposited',
            body: '{{amount}} from {{source}} — Balance {{available_balance}}',
            action: 'open_wallet',
          },
          whatsapp: {
            templateName: 'funds_deposited_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{amount}}',
                  '{{source}}',
                  '{{available_balance}}',
                ],
              },
            ],
          },
        },
      },

      // ── RISK-003: Position Squared Off ───────────────────────────
      {
        templateId: 'RISK-003-v1',
        eventType: 'RISK-003',
        version: 1,
        channels: {
          sms: {
            body: 'Positions SQUARED OFF: P&L impact {{pnl_impact}}. Remaining positions: {{remaining_positions}}. -{{app_name}}',
          },
          push: {
            title: '⚠️ Position Squared Off',
            body: 'P&L: {{pnl_impact}} | Remaining: {{remaining_positions}}',
            data: { action: 'open_portfolio', priority: '1' },
          },
          email: {
            subject: 'Positions Squared Off — P&L Impact {{pnl_impact}}',
            textBody:
              'Dear {{user_name}}, your positions have been squared off due to margin shortfall. ' +
              'P&L impact: {{pnl_impact}}. Remaining positions: {{remaining_positions}}.',
          },
          in_app: {
            title: 'Position Squared Off',
            body: 'P&L: {{pnl_impact}} | Remaining: {{remaining_positions}}',
            action: 'open_portfolio',
          },
          whatsapp: {
            templateName: 'position_squared_off_v1',
            components: [
              {
                type: 'body',
                parameters: ['{{pnl_impact}}', '{{remaining_positions}}'],
              },
            ],
          },
        },
      },

      // ── RISK-004: Portfolio Risk Alert ───────────────────────────
      {
        templateId: 'RISK-004-v1',
        eventType: 'RISK-004',
        version: 1,
        channels: {
          push: {
            title: '📊 Portfolio Risk Alert',
            body: 'Risk metric breached: {{risk_metric}}. Review affected holdings.',
            data: { action: 'open_risk_dashboard' },
          },
          email: {
            subject: 'Portfolio Risk Alert: {{risk_metric}} Breached',
            textBody:
              'Dear {{user_name}}, a risk metric has been breached in your portfolio. ' +
              'Metric: {{risk_metric}}. Affected holdings: {{affected_holdings}}. Suggestion: {{suggestion}}.',
          },
          in_app: {
            title: 'Portfolio Risk Alert',
            body: '{{risk_metric}} breached — {{suggestion}}',
            action: 'open_risk_dashboard',
          },
          whatsapp: {
            templateName: 'portfolio_risk_alert_v1',
            components: [
              {
                type: 'body',
                parameters: ['{{risk_metric}}', '{{affected_holdings}}'],
              },
            ],
          },
        },
      },

      // ── RISK-005: Concentration Alert ────────────────────────────
      {
        templateId: 'RISK-005-v1',
        eventType: 'RISK-005',
        version: 1,
        channels: {
          email: {
            subject:
              'Concentration Alert: {{sector_or_stock}} at {{pct_allocation}}%',
            textBody:
              'Dear {{user_name}}, your portfolio is over-concentrated in {{sector_or_stock}} ' +
              'at {{pct_allocation}}% allocation. Consider rebalancing.',
          },
          in_app: {
            title: 'Concentration Alert',
            body: '{{sector_or_stock}} at {{pct_allocation}}% — consider rebalancing',
            action: 'open_portfolio',
          },
          whatsapp: {
            templateName: 'concentration_alert_v1',
            components: [
              {
                type: 'body',
                parameters: ['{{sector_or_stock}}', '{{pct_allocation}}'],
              },
            ],
          },
        },
      },

      // ── SIPX-003: SIP Failed ──────────────────────────────────────
      {
        templateId: 'SIPX-003-v1',
        eventType: 'SIPX-003',
        version: 1,
        channels: {
          sms: {
            body: 'SIP FAILED: {{fund_name}} {{amount}}. Reason: {{reason}}. Retry: {{retry_date}}. -{{app_name}}',
          },
          push: {
            title: '❌ SIP Failed',
            body: '{{fund_name}}: {{reason}}. Retry on {{retry_date}}.',
            data: { action: 'open_sip' },
          },
          email: {
            subject: 'SIP Payment Failed: {{fund_name}}',
            textBody:
              'Dear {{user_name}}, your SIP payment of {{amount}} for {{fund_name}} failed. ' +
              'Reason: {{reason}}. Next retry: {{retry_date}}. Please ensure sufficient balance.',
          },
          in_app: {
            title: 'SIP Payment Failed',
            body: '{{fund_name}} — {{reason}}. Next retry: {{retry_date}}',
            action: 'open_sip',
          },
          whatsapp: {
            templateName: 'sip_failed_v1',
            components: [
              {
                type: 'body',
                parameters: ['{{fund_name}}', '{{reason}}', '{{retry_date}}'],
              },
            ],
          },
        },
      },

      // ── SIPX-004: SIP Step-Up Reminder ───────────────────────────
      {
        templateId: 'SIPX-004-v1',
        eventType: 'SIPX-004',
        version: 1,
        channels: {
          email: {
            subject: 'SIP Step-Up Reminder: {{fund_name}}',
            textBody:
              'Dear {{user_name}}, consider stepping up your SIP for {{fund_name}}. ' +
              'Current amount: {{current_amount}}. Suggested increase: {{suggested_increase}}. ' +
              'Goal impact: {{goal_impact}}.',
          },
          in_app: {
            title: 'SIP Step-Up Suggestion',
            body: '{{fund_name}}: increase from {{current_amount}} for better goal alignment',
            action: 'open_sip',
          },
          whatsapp: {
            templateName: 'sip_stepup_reminder_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{fund_name}}',
                  '{{current_amount}}',
                  '{{suggested_increase}}',
                ],
              },
            ],
          },
        },
      },

      // ── SIPX-005: Goal Milestone Reached ─────────────────────────
      {
        templateId: 'SIPX-005-v1',
        eventType: 'SIPX-005',
        version: 1,
        channels: {
          push: {
            title: '🎯 Goal Milestone Reached!',
            body: '{{goal_name}}: {{pct_complete}}% complete. Projected completion: {{projected_completion}}.',
            data: { action: 'open_goals' },
          },
          in_app: {
            title: 'Goal Milestone',
            body: '{{goal_name}} is {{pct_complete}}% complete!',
            action: 'open_goals',
          },
          whatsapp: {
            templateName: 'goal_milestone_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{goal_name}}',
                  '{{pct_complete}}',
                  '{{projected_completion}}',
                ],
              },
            ],
          },
        },
      },

      // ── MKTX-003: Market Open/Close ──────────────────────────────
      {
        templateId: 'MKTX-003-v1',
        eventType: 'MKTX-003',
        version: 1,
        channels: {
          push: {
            title: '🔔 Market {{market_event}}',
            body: 'Index: {{index_level}} | Portfolio overnight change: {{overnight_change}}',
            data: { action: 'open_markets' },
          },
          in_app: {
            title: 'Market {{market_event}}',
            body: '{{index_level}} | Overnight: {{overnight_change}}',
            action: 'open_markets',
          },
          whatsapp: {
            templateName: 'market_open_close_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{market_event}}',
                  '{{index_level}}',
                  '{{overnight_change}}',
                ],
              },
            ],
          },
        },
      },

      // ── MKTX-004: 52-Week High/Low ───────────────────────────────
      {
        templateId: 'MKTX-004-v1',
        eventType: 'MKTX-004',
        version: 1,
        channels: {
          push: {
            title: '📈 52-Week {{milestone_type}}: {{stock_name}}',
            body: '{{stock_name}} hit a new 52-week {{milestone_type}} at {{price}}. You hold {{holding_status}}.',
            data: { action: 'open_stock', symbol: '{{symbol}}' },
          },
          email: {
            subject: '52-Week {{milestone_type}}: {{stock_name}} at {{price}}',
            textBody:
              'Dear {{user_name}}, {{stock_name}} has reached a 52-week {{milestone_type}} at {{price}}. ' +
              'Your holding status: {{holding_status}}.',
          },
          in_app: {
            title: '52-Week {{milestone_type}}',
            body: '{{stock_name}} — {{price}} ({{milestone_type}})',
            action: 'open_stock',
          },
          whatsapp: {
            templateName: 'week_high_low_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{stock_name}}',
                  '{{milestone_type}}',
                  '{{price}}',
                ],
              },
            ],
          },
        },
      },

      // ── MKTX-005: Earnings Announcement ──────────────────────────
      {
        templateId: 'MKTX-005-v1',
        eventType: 'MKTX-005',
        version: 1,
        channels: {
          email: {
            subject:
              'Earnings Announcement: {{company}} on {{announcement_date}}',
            textBody:
              'Dear {{user_name}}, {{company}} will announce earnings on {{announcement_date}}. ' +
              'Expected EPS: {{expected_eps}}. Historical context: {{historical_context}}.',
          },
          in_app: {
            title: 'Earnings Announcement',
            body: '{{company}} — {{announcement_date}} | Expected EPS: {{expected_eps}}',
            action: 'open_stock',
          },
          whatsapp: {
            templateName: 'earnings_announcement_v1',
            components: [
              {
                type: 'body',
                parameters: [
                  '{{company}}',
                  '{{announcement_date}}',
                  '{{expected_eps}}',
                ],
              },
            ],
          },
        },
      },

      // ── REGX-002: Nominee Update Reminder ────────────────────────
      {
        templateId: 'REGX-002-v1',
        eventType: 'REGX-002',
        version: 1,
        channels: {
          email: {
            subject: 'Nominee Update Required — SEBI Circular',
            textBody:
              'Dear {{user_name}}, please update your nominee details as per SEBI circular. ' +
              'Current nominee status: {{nominee_status}}. Deadline: {{deadline}}.',
          },
          push: {
            title: 'Nominee Update Required',
            body: 'Update your nominee details by {{deadline}} — SEBI requirement',
            data: { action: 'open_profile' },
          },
          in_app: {
            title: 'Nominee Update',
            body: '{{nominee_status}} — update required by {{deadline}}',
            action: 'open_profile',
          },
          whatsapp: {
            templateName: 'nominee_update_v1',
            components: [
              {
                type: 'body',
                parameters: ['{{nominee_status}}', '{{deadline}}'],
              },
            ],
          },
        },
      },

      // ── REGX-003: Contract Note Generated ────────────────────────
      {
        templateId: 'REGX-003-v1',
        eventType: 'REGX-003',
        version: 1,
        channels: {
          email: {
            subject: 'Contract Note Generated — {{trade_date}}',
            textBody:
              'Dear {{user_name}}, your contract note for trades on {{trade_date}} has been generated. ' +
              'Summary: {{summary}}. Download link: {{download_link}}.',
          },
          in_app: {
            title: 'Contract Note Ready',
            body: 'Contract note for {{trade_date}} is available for download',
            action: 'open_documents',
          },
          whatsapp: {
            templateName: 'contract_note_v1',
            components: [
              {
                type: 'body',
                parameters: ['{{trade_date}}', '{{download_link}}'],
              },
            ],
          },
        },
      },

      // ── REGX-004: Tax Statement Available ────────────────────────
      {
        templateId: 'REGX-004-v1',
        eventType: 'REGX-004',
        version: 1,
        channels: {
          email: {
            subject: 'Tax Statement Available: {{period}}',
            textBody:
              'Dear {{user_name}}, your tax statement for {{period}} is now available. ' +
              'Key figures: {{key_figures}}. Download: {{download_link}}.',
          },
          in_app: {
            title: 'Tax Statement Available',
            body: '{{period}} tax statement ready — download now',
            action: 'open_documents',
          },
          whatsapp: {
            templateName: 'tax_statement_v1',
            components: [
              { type: 'body', parameters: ['{{period}}', '{{download_link}}'] },
            ],
          },
        },
      },
    ];
  }
}
