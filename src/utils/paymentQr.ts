import { ArifPaySession } from '../services/arifpayGatewayService';
import { TelebirrUssdQrSession } from '../services/telebirrGatewayService';

export type PaymentGatewayKind =
  | 'Telebirr USSD QR'
  | 'ArifPay Checkout'
  | 'CBE Transfer Slip';

export interface ParsedPaymentQr {
  gateway: PaymentGatewayKind;
  reference: string;
  sessionId?: string;
  transactionId?: string;
  invoiceNumber?: string;
  amountEtb?: number;
  merchantCode?: string;
  rawPayload: string;
}

/**
 * Builds a complete, scannable Telebirr QR payload string including the transaction reference
 * so camera QR scanners can auto-populate the reference field directly.
 */
export function buildTelebirrQrPayload(session: TelebirrUssdQrSession): string {
  const base = session.qrPayload;
  if (/[?&]ref=/i.test(base)) {
    return base;
  }
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ref=${encodeURIComponent(session.transactionRef)}`;
}

/**
 * Builds a complete, scannable ArifPay checkout QR payload encoding the hosted session URL,
 * transaction ID, invoice number, and ETB amount.
 */
export function buildArifPayQrPayload(session: ArifPaySession): string {
  const sep = session.checkoutUrl.includes('?') ? '&' : '?';
  return `${session.checkoutUrl}${sep}tx=${encodeURIComponent(
    session.transactionId
  )}&inv=${encodeURIComponent(session.invoiceNumber)}&amt=${encodeURIComponent(
    String(session.amountEtb)
  )}`;
}

/**
 * Parses Telebirr, ArifPay, or raw bank/gateway QR payloads into a normalized reference object.
 */
export function parsePaymentQrPayload(raw: string): ParsedPaymentQr | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Telebirr URI: telebirr://pay?merch=204910&inv=INV-...&amt=22000&sess=TB-SESS-123456&ref=TEL-QR-123456&mode=SANDBOX
  if (/^telebirr:\/\//i.test(trimmed)) {
    try {
      const normalizedUrl = trimmed.replace(/^telebirr:\/\//i, 'https://telebirr.local/');
      const url = new URL(normalizedUrl);
      const sess = url.searchParams.get('sess') || undefined;
      const refParam = url.searchParams.get('ref') || undefined;
      const inv = url.searchParams.get('inv') || undefined;
      const amtRaw = url.searchParams.get('amt');
      const amt = amtRaw && Number.isFinite(Number(amtRaw)) && Number(amtRaw) > 0
        ? Number(amtRaw)
        : undefined;
      const merch = url.searchParams.get('merch') || undefined;
      const reference = refParam || sess || `TEL-QR-${trimmed.slice(-6)}`;
      return {
        gateway: 'Telebirr USSD QR',
        reference,
        sessionId: sess,
        invoiceNumber: inv,
        amountEtb: amt,
        merchantCode: merch,
        rawPayload: trimmed,
      };
    } catch {
      return {
        gateway: 'Telebirr USSD QR',
        reference: trimmed,
        rawPayload: trimmed,
      };
    }
  }

  // 2. ArifPay URI or Hosted Checkout URL:
  // https://gateway.arifpay.org/sandbox/checkout/AP-SESS-123456?tx=AP-TX-1234567&inv=...&amt=...
  if (/arifpay/i.test(trimmed) || /\/AP-SESS-\d+/i.test(trimmed)) {
    try {
      const normalizedUrl = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : trimmed.replace(/^arifpay:\/\//i, 'https://gateway.arifpay.org/');
      const url = new URL(normalizedUrl);
      const pathMatch = url.pathname.match(/(AP-SESS-[A-Za-z0-9_-]+)/i);
      const sessionId = url.searchParams.get('sess') || pathMatch?.[1] || undefined;
      const tx = url.searchParams.get('tx') || url.searchParams.get('ref') || undefined;
      const inv = url.searchParams.get('inv') || undefined;
      const amtRaw = url.searchParams.get('amt');
      const amt = amtRaw && Number.isFinite(Number(amtRaw)) && Number(amtRaw) > 0
        ? Number(amtRaw)
        : undefined;
      const reference = tx || sessionId || trimmed;
      return {
        gateway: 'ArifPay Checkout',
        reference,
        sessionId,
        transactionId: tx,
        invoiceNumber: inv,
        amountEtb: amt,
        rawPayload: trimmed,
      };
    } catch {
      const sessMatch = trimmed.match(/(AP-SESS-[A-Za-z0-9_-]+)/i);
      const txMatch = trimmed.match(/(AP-TX-[A-Za-z0-9_-]+)/i);
      return {
        gateway: 'ArifPay Checkout',
        reference: txMatch?.[1] || sessMatch?.[1] || trimmed,
        sessionId: sessMatch?.[1],
        transactionId: txMatch?.[1],
        rawPayload: trimmed,
      };
    }
  }

  // 3. Raw Telebirr reference/session token
  if (/^(TB-SESS-|TEL-QR-|TB-TRACE-)/i.test(trimmed)) {
    return {
      gateway: 'Telebirr USSD QR',
      reference: trimmed,
      sessionId: /^TB-SESS-/i.test(trimmed) ? trimmed : undefined,
      rawPayload: trimmed,
    };
  }

  // 4. Raw ArifPay reference/session token
  if (/^(AP-SESS-|AP-TX-)/i.test(trimmed)) {
    return {
      gateway: 'ArifPay Checkout',
      reference: trimmed,
      sessionId: /^AP-SESS-/i.test(trimmed) ? trimmed : undefined,
      transactionId: /^AP-TX-/i.test(trimmed) ? trimmed : undefined,
      rawPayload: trimmed,
    };
  }

  // 5. Generic CBE / bank slip QR string
  return {
    gateway: 'CBE Transfer Slip',
    reference: trimmed.slice(0, 80),
    rawPayload: trimmed,
  };
}
