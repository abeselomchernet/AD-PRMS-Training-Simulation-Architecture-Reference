import React, { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertCircle,
  Bell,
  Building2,
  Camera,
  CheckCircle2,
  CreditCard,
  Download,
  FileSpreadsheet,
  FileText,
  Globe,
  Home,
  LogOut,
  MessageSquare,
  Moon,
  Plus,
  QrCode,
  Receipt,
  Send,
  ShieldCheck,
  Smartphone,
  Sun,
  User,
  Wrench,
  Zap,
} from 'lucide-react';
import { usePrms } from '../../context/PrmsContext';
import { useTheme } from '../../context/ThemeContext';
import { biText } from '../../data/i18n';
import {
  createTelebirrUssdQrSession,
  runMockTelebirrFlow,
  TELEBIRR_SANDBOX_CONFIG,
  TelebirrUssdQrSession,
} from '../../services/telebirrGatewayService';
import {
  ArifPayOutcome,
  ArifPaySelectedMethod,
  ArifPaySession,
  createArifPayCheckoutSession,
  simulateArifPayHostedPayment,
  verifyArifPaySessionFallback,
} from '../../services/arifpayGatewayService';
import { ChargeRecord, DateDisplayMode, PaymentReceipt } from '../../types/prms';
import {
  buildArifPayQrPayload,
  buildTelebirrQrPayload,
  ParsedPaymentQr,
} from '../../utils/paymentQr';
import { downloadExportFile } from '../../utils/exportDownload';
import { OfflineIndicator, PWAInstallButton } from '../pwa/PWAInstallButton';
import { BottomSheet } from './BottomSheet';
import { PaymentQrScannerSheet } from './PaymentQrScannerSheet';
import { DocumentUploadField, UploadedEvidenceFile } from '../ui/DocumentUploadField';
import { StatusLabel, ValidationSummary } from '../ui/Primitives';
import { useWebPush } from '../../hooks/useWebPush';

type TenantTab = 'home' | 'pay' | 'repairs' | 'notices' | 'account';
type CheckoutGateway = 'Telebirr USSD QR' | 'ArifPay Checkout' | 'CBE Transfer Slip';

export const TenantMobileApp: React.FC = () => {
  const {
    activeTenantAccount,
    activeOwner,
    ownerUnits,
    ownerTenants,
    ownerLeases,
    ownerCharges,
    ownerReceipts,
    ownerGatewayPayments,
    ownerMaintenanceTickets,
    ownerMaintenanceMessages,
    ownerTenantNotices,
    ownerSmsLogs,
    ownerTenantPrefs,
    logoutTenant,
    sendMaintenanceMessage,
    createTenantMaintenanceTicket,
    markTenantNoticeRead,
    updateTenantNotificationPrefs,
    submitTenantMobilePayment,
    locale,
    setLocale,
    dateMode,
    setDateMode,
    fmtDate,
    fmtDateTime,
    fmtEtb,
    notify,
    toasts,
    dismissToast,
  } = usePrms();
  const { theme, toggleTheme } = useTheme();

  const [activeTab, setActiveTab] = useState<TenantTab>('home');
  const [accountSubView, setAccountSubView] = useState<'docs' | 'profile'>('docs');

  // Checkout BottomSheet state
  const [checkoutCharge, setCheckoutCharge] = useState<ChargeRecord | null>(null);
  const [gateway, setGateway] = useState<CheckoutGateway>('Telebirr USSD QR');
  const [payAmountEtb, setPayAmountEtb] = useState<number>(0);
  const [msisdn, setMsisdn] = useState(activeTenantAccount?.msisdnPlaceholder || '+251910000001');
  const [cbeRef, setCbeRef] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payErrors, setPayErrors] = useState<string[]>([]);
  const [telebirrSession, setTelebirrSession] = useState<TelebirrUssdQrSession | null>(null);
  const [telebirrQrDataUrl, setTelebirrQrDataUrl] = useState<string>('');
  const [arifpayMethod, setArifpayMethod] = useState<ArifPaySelectedMethod>('TELEBIRR');
  const [arifpayOutcome, setArifpayOutcome] = useState<ArifPayOutcome>('COMPLETED');
  const [arifpaySession, setArifpaySession] = useState<ArifPaySession | null>(null);
  const [arifpayQrDataUrl, setArifpayQrDataUrl] = useState<string>('');
  const [arifpayBusy, setArifpayBusy] = useState(false);
  const [cbeSlipFile, setCbeSlipFile] = useState<UploadedEvidenceFile | null>(null);
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [qrScanBanner, setQrScanBanner] = useState<string | null>(null);
  const [historyExportMessage, setHistoryExportMessage] = useState<string | null>(null);

  // Receipt Preview Sheet
  const [previewReceipt, setPreviewReceipt] = useState<PaymentReceipt | null>(null);

  // New Repair Ticket Sheet
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [ticketForm, setTicketForm] = useState({
    unitId: '',
    category: 'Maintenance' as 'Maintenance' | 'Complaint',
    priority: 'Medium' as 'Low' | 'Medium' | 'High' | 'Urgent',
    title: '',
    description: '',
  });
  const [repairPhotoFile, setRepairPhotoFile] = useState<UploadedEvidenceFile | null>(null);
  const [ticketErrors, setTicketErrors] = useState<string[]>([]);
  const webPush = useWebPush('Tenant Mobile PWA');

  // Active Ticket Chat Sheet
  const [chatTicketId, setChatTicketId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');

  // Profile MSISDN draft
  const tenantId = activeTenantAccount?.tenantId || '';
  const tenantRecord = useMemo(
    () => ownerTenants.find((t) => t.id === tenantId) || null,
    [ownerTenants, tenantId]
  );

  // Strictly scoped projections for the signed-in tenant ONLY
  const myLeases = useMemo(
    () => ownerLeases.filter((l) => l.tenantId === tenantId),
    [ownerLeases, tenantId]
  );
  const myUnitIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...myLeases.map((l) => l.unitId),
          ...ownerUnits.filter((u) => u.currentTenantId === tenantId).map((u) => u.id),
        ])
      ),
    [myLeases, ownerUnits, tenantId]
  );
  const myUnits = useMemo(
    () => ownerUnits.filter((u) => myUnitIds.includes(u.id)),
    [ownerUnits, myUnitIds]
  );
  const myCharges = useMemo(
    () => ownerCharges.filter((c) => c.tenantId === tenantId),
    [ownerCharges, tenantId]
  );
  const myOpenCharges = useMemo(
    () => myCharges.filter((c) => c.billedEtb > c.paidEtb),
    [myCharges]
  );
  const myReceipts = useMemo(
    () => ownerReceipts.filter((r) => r.tenantId === tenantId),
    [ownerReceipts, tenantId]
  );
  const myProcessedQrPayments = useMemo(() => {
    const qrGatewayRecords = ownerGatewayPayments
      .filter(
        (g) =>
          g.tenantId === tenantId &&
          g.status === 'Verified' &&
          (g.gatewayType === 'Telebirr USSD QR' || g.gatewayType === 'ArifPay Checkout')
      )
      .map((g) => {
        const linkedReceipt = g.receiptId
          ? myReceipts.find((r) => r.id === g.receiptId)
          : undefined;
        const matchedCharge = myCharges.find((c) => c.id === g.chargeId);
        return {
          id: g.id,
          gatewayType: g.gatewayType,
          status: g.status,
          date: g.verifiedAt || g.submittedAt,
          referenceNumber: g.referenceNumber,
          amountEtb: g.amountEtb,
          invoiceNumber: matchedCharge?.invoiceNumber,
          receipt: linkedReceipt,
        };
      });

    const linkedReceiptIds = new Set(
      qrGatewayRecords.map((item) => item.receipt?.id).filter(Boolean) as string[]
    );

    const unlinkedQrReceipts = myReceipts
      .filter(
        (r) =>
          !linkedReceiptIds.has(r.id) &&
          r.documentState !== 'Reversed' &&
          (r.method === 'Telebirr (Synthetic)' || r.method === 'ArifPay (Synthetic)')
      )
      .map((r) => ({
        id: r.id,
        gatewayType:
          r.method === 'Telebirr (Synthetic)'
            ? ('Telebirr USSD QR' as const)
            : ('ArifPay Checkout' as const),
        status: 'Processed' as const,
        date: r.paymentDate,
        referenceNumber: r.referencePlaceholder,
        amountEtb: r.amountEtb,
        invoiceNumber: r.allocations[0]?.invoiceNumber,
        receipt: r,
      }));

    return [...qrGatewayRecords, ...unlinkedQrReceipts].sort((a, b) =>
      b.date.localeCompare(a.date)
    );
  }, [ownerGatewayPayments, myReceipts, myCharges, tenantId]);

  const myProcessedPaymentHistory = useMemo(() => {
    const verifiedGateways = ownerGatewayPayments
      .filter((g) => g.tenantId === tenantId && g.status === 'Verified')
      .map((g) => {
        const linkedReceipt = g.receiptId
          ? myReceipts.find((r) => r.id === g.receiptId)
          : undefined;
        const matchedCharge = myCharges.find((c) => c.id === g.chargeId);
        return {
          id: g.id,
          date: g.verifiedAt || g.submittedAt,
          method: g.gatewayType,
          invoiceNumber: matchedCharge?.invoiceNumber || linkedReceipt?.allocations[0]?.invoiceNumber || '-',
          referenceNumber: g.referenceNumber,
          amountEtb: g.amountEtb,
          status: 'Verified',
          receiptId: linkedReceipt?.id,
        };
      });

    const coveredReceiptIds = new Set(
      verifiedGateways.map((item) => item.receiptId).filter(Boolean) as string[]
    );

    const remainingReceipts = myReceipts
      .filter((r) => !coveredReceiptIds.has(r.id) && r.documentState !== 'Reversed')
      .map((r) => ({
        id: r.id,
        date: r.paymentDate,
        method: r.method,
        invoiceNumber: r.allocations.map((a) => a.invoiceNumber).join(', ') || '-',
        referenceNumber: r.referencePlaceholder,
        amountEtb: r.amountEtb,
        status: r.documentState,
        receiptId: r.id,
      }));

    return [...verifiedGateways, ...remainingReceipts].sort((a, b) =>
      b.date.localeCompare(a.date)
    );
  }, [ownerGatewayPayments, myReceipts, myCharges, tenantId]);

  const handleDownloadPaymentHistory = (format: 'PDF' | 'Excel') => {
    if (myProcessedPaymentHistory.length === 0) return;
    const tenantDisplay = tenantRecord?.name || activeTenantAccount?.displayName || tenantId;
    const result = downloadExportFile(format, {
      title: `Tenant Processed Payment History - ${tenantDisplay}`,
      ownerName: activeOwner.name,
      columns: ['Date', 'Gateway / Method', 'Invoice #', 'Reference', 'Amount (ETB)', 'Status'],
      rows: myProcessedPaymentHistory.map((item) => [
        fmtDateTime(item.date),
        item.method,
        item.invoiceNumber,
        item.referenceNumber,
        fmtEtb(item.amountEtb),
        item.status,
      ]),
      includeMetadataHeader: true,
      pdfOrientation: 'landscape',
    });

    const msg = biText(
      locale,
      `Downloaded ${result.filename} (${myProcessedPaymentHistory.length} processed payment record(s)).`,
      `${result.filename} ወርዷል (${myProcessedPaymentHistory.length} የተከናወኑ የክፍያ መዝገቦች)።`
    );
    setHistoryExportMessage(msg);
    notify({
      tone: 'success',
      title: biText(locale, `Payment History ${format} Downloaded`, `የክፍያ ታሪክ ${format} ወርዷል`),
      detail: msg,
    });
  };
  const myTickets = useMemo(
    () => ownerMaintenanceTickets.filter((m) => myUnitIds.includes(m.unitId)),
    [ownerMaintenanceTickets, myUnitIds]
  );
  // Tenant NEVER sees Internal Staff Note
  const myVisibleMessages = useMemo(
    () =>
      ownerMaintenanceMessages.filter(
        (m) => m.visibility === 'Shared with Tenant' && myTickets.some((t) => t.id === m.ticketId)
      ),
    [ownerMaintenanceMessages, myTickets]
  );
  const myNotices = useMemo(
    () => ownerTenantNotices.filter((n) => n.tenantId === 'ALL' || n.tenantId === tenantId),
    [ownerTenantNotices, tenantId]
  );
  const unreadNoticesCount = useMemo(
    () => myNotices.filter((n) => !n.readByTenantIds.includes(tenantId)).length,
    [myNotices, tenantId]
  );
  const mySmsLogs = useMemo(
    () => ownerSmsLogs.filter((s) => s.tenantId === tenantId),
    [ownerSmsLogs, tenantId]
  );
  const myPrefs = useMemo(
    () =>
      ownerTenantPrefs.find((p) => p.tenantId === tenantId) || {
        tenantId,
        ownerId: activeOwner.id,
        msisdn: activeTenantAccount?.msisdnPlaceholder || '+251910000001',
        smsEnabled: true,
        pushEnabled: true,
        preferredLocale: locale,
      },
    [ownerTenantPrefs, tenantId, activeOwner.id, activeTenantAccount, locale]
  );

  const [msisdnDraft, setMsisdnDraft] = useState(myPrefs.msisdn);

  useEffect(() => {
    let active = true;
    if (!telebirrSession) {
      setTelebirrQrDataUrl('');
      return () => {
        active = false;
      };
    }
    const payload = buildTelebirrQrPayload(telebirrSession);
    void QRCode.toDataURL(payload, { width: 176, margin: 2, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (active) setTelebirrQrDataUrl(url);
      })
      .catch(() => {
        if (active) setTelebirrQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [telebirrSession]);

  useEffect(() => {
    let active = true;
    if (!arifpaySession) {
      setArifpayQrDataUrl('');
      return () => {
        active = false;
      };
    }
    const payload = buildArifPayQrPayload(arifpaySession);
    void QRCode.toDataURL(payload, { width: 176, margin: 2, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (active) setArifpayQrDataUrl(url);
      })
      .catch(() => {
        if (active) setArifpayQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [arifpaySession]);

  if (!activeTenantAccount) return null;

  const totalOpenBalance = myOpenCharges.reduce((s, c) => s + (c.billedEtb - c.paidEtb), 0);
  const activeLease = myLeases.find((l) => l.status === 'Active') || myLeases[0] || null;

  const openCheckout = (ch: ChargeRecord) => {
    const due = Math.max(0, ch.billedEtb - ch.paidEtb);
    setCheckoutCharge(ch);
    setGateway('Telebirr USSD QR');
    setPayAmountEtb(due);
    setMsisdn(myPrefs.msisdn || activeTenantAccount.msisdnPlaceholder);
    setCbeRef('');
    setPaymentReference('');
    setPayNotes('');
    setPayErrors([]);
    setQrScanBanner(null);
    setTelebirrSession(null);
    setArifpaySession(null);
  };

  const matchQrToInvoice = (parsed: ParsedPaymentQr) => {
    if (parsed.invoiceNumber) {
      const matched = myCharges.find(
        (c) => c.invoiceNumber.toLowerCase() === parsed.invoiceNumber!.toLowerCase()
      );
      if (!matched) {
        return {
          matched: false,
          reason: biText(
            locale,
            `Invoice ${parsed.invoiceNumber} does not match any invoice assigned to your unit.`,
            `ደረሰኝ ${parsed.invoiceNumber} ለእርስዎ ክፍል ከተመደቡ ደረሰኞች ጋር አይዛመድም።`
          ),
        };
      }
      if (matched.billedEtb <= matched.paidEtb) {
        return {
          matched: false,
          invoiceNumber: matched.invoiceNumber,
          reason: biText(
            locale,
            `Invoice ${matched.invoiceNumber} is already settled.`,
            `ደረሰኝ ${matched.invoiceNumber} አስቀድሞ ተከፍሏል።`
          ),
        };
      }
      return { matched: true, invoiceNumber: matched.invoiceNumber };
    }

    const fallbackOpen = checkoutCharge || myOpenCharges[0];
    if (!fallbackOpen) {
      return {
        matched: false,
        reason: biText(
          locale,
          'No open rent invoice is available to match this QR reference.',
          'ከዚህ የQR ማጣቀሻ ጋር የሚዛመድ ክፍት የኪራይ ደረሰኝ የለም።'
        ),
      };
    }

    const isRecognizedGatewayRef =
      parsed.gateway === 'Telebirr USSD QR' ||
      parsed.gateway === 'ArifPay Checkout' ||
      /^(TB-SESS-|TEL-QR-|TB-TRACE-|AP-SESS-|AP-TX-|CBE-)/i.test(parsed.reference);

    if (!isRecognizedGatewayRef) {
      return {
        matched: false,
        reason: biText(
          locale,
          `Unrecognized QR payload (${parsed.reference}). Scan a Telebirr or ArifPay checkout QR.`,
          `ያልታወቀ የQR መረጃ (${parsed.reference})። የቴሌብር ወይም አሪፍፔይ QR ይቃኙ።`
        ),
      };
    }

    return { matched: true, invoiceNumber: fallbackOpen.invoiceNumber };
  };

  const handleQrDecoded = (parsed: ParsedPaymentQr) => {
    const targetCharge =
      checkoutCharge ||
      (parsed.invoiceNumber
        ? myOpenCharges.find(
            (c) => c.invoiceNumber.toLowerCase() === parsed.invoiceNumber!.toLowerCase()
          ) ||
          myCharges.find(
            (c) => c.invoiceNumber.toLowerCase() === parsed.invoiceNumber!.toLowerCase()
          )
        : undefined) ||
      myOpenCharges[0] ||
      myCharges[0] ||
      null;

    setQrScannerOpen(false);
    if (!targetCharge) {
      setPayErrors([
        biText(
          locale,
          `Decoded QR reference ${parsed.reference}, but no invoice is assigned to this tenant.`,
          `የQR ማጣቀሻ ${parsed.reference} ተነቧል፣ ነገር ግን ለዚህ ተከራይ የተመደበ ደረሰኝ የለም።`
        ),
      ]);
      return;
    }

    const due = Math.max(0, targetCharge.billedEtb - targetCharge.paidEtb);
    const resolvedAmount =
      parsed.amountEtb && parsed.amountEtb > 0
        ? due > 0
          ? Math.min(parsed.amountEtb, due)
          : parsed.amountEtb
        : due || targetCharge.billedEtb;

    setCheckoutCharge(targetCharge);
    setGateway(parsed.gateway);
    setPayAmountEtb(resolvedAmount);
    setMsisdn(myPrefs.msisdn || activeTenantAccount.msisdnPlaceholder);
    setPaymentReference(parsed.reference);
    setCbeRef(parsed.reference);
    setPayNotes(`QR scanned (${parsed.gateway}): ${parsed.reference}`);
    setPayErrors([]);
    setQrScanBanner(
      biText(
        locale,
        `QR decoded (${parsed.gateway}) · Reference auto-populated: ${parsed.reference}`,
        `QR ተነቧል (${parsed.gateway}) · ማጣቀሻ ተሞልቷል፡ ${parsed.reference}`
      )
    );
  };

  const handleTelebirrQuickPay = () => {
    if (!checkoutCharge) return;
    setPayErrors([]);
    const due = Math.max(0, checkoutCharge.billedEtb - checkoutCharge.paidEtb);
    const res = runMockTelebirrFlow({
      ownerId: activeOwner.id,
      tenantId,
      tenantName: tenantRecord?.name || activeTenantAccount.displayName,
      unitId: checkoutCharge.unitId,
      chargeId: checkoutCharge.id,
      invoiceNumber: checkoutCharge.invoiceNumber,
      amountEtb: payAmountEtb,
      openBalanceEtb: due,
      msisdn,
    });
    if (!res.ok) {
      setPayErrors(res.errors);
      return;
    }
    setTelebirrSession(res.session);
    if (res.session.step === 'SETTLED') {
      const receipt = submitTenantMobilePayment({
        gatewayType: 'Telebirr USSD QR',
        tenantId,
        unitId: checkoutCharge.unitId,
        chargeId: checkoutCharge.id,
        amountEtb: res.session.amountEtb,
        referenceNumber: res.session.transactionRef,
        phoneOrAccount: res.session.msisdn,
        notes: `Tenant Mobile Telebirr USSD QR (${res.session.ussdDialString})`,
        ussdSessionId: res.session.sessionId,
        ussdDialString: res.session.ussdDialString,
        traceId: res.session.traceId,
        autoVerified: true,
      });
      if (receipt) {
        setCheckoutCharge(null);
        setPreviewReceipt(receipt);
      }
    }
  };

  const handleGenerateTelebirrQr = () => {
    if (!checkoutCharge) return;
    setPayErrors([]);
    const due = Math.max(0, checkoutCharge.billedEtb - checkoutCharge.paidEtb);
    const res = createTelebirrUssdQrSession({
      ownerId: activeOwner.id,
      tenantId,
      tenantName: tenantRecord?.name || activeTenantAccount.displayName,
      unitId: checkoutCharge.unitId,
      chargeId: checkoutCharge.id,
      invoiceNumber: checkoutCharge.invoiceNumber,
      amountEtb: payAmountEtb,
      openBalanceEtb: due,
      msisdn,
    });
    if (!res.ok) {
      setPayErrors(res.errors);
      return;
    }
    setTelebirrSession(res.session);
    setPaymentReference(res.session.transactionRef);
    setCbeRef(res.session.transactionRef);
  };

  const handleSettleTelebirrReference = () => {
    if (!checkoutCharge) return;
    setPayErrors([]);
    const refToUse = (paymentReference || telebirrSession?.transactionRef || '').trim();
    if (!refToUse) {
      setPayErrors([
        biText(
          locale,
          'Generate a Telebirr QR or scan a payment QR to populate the reference field.',
          'የማጣቀሻ ቁጥሩን ለመሙላት የቴሌብር QR ይፍጠሩ ወይም QR ስካን ያድርጉ።'
        ),
      ]);
      return;
    }
    const due = Math.max(0, checkoutCharge.billedEtb - checkoutCharge.paidEtb);
    if (!payAmountEtb || payAmountEtb <= 0 || payAmountEtb > due) {
      setPayErrors([`Payment amount must be between ETB 1 and ETB ${due.toLocaleString()}.`]);
      return;
    }
    const receipt = submitTenantMobilePayment({
      gatewayType: 'Telebirr USSD QR',
      tenantId,
      unitId: checkoutCharge.unitId,
      chargeId: checkoutCharge.id,
      amountEtb: payAmountEtb,
      referenceNumber: refToUse,
      phoneOrAccount: msisdn,
      notes: `Tenant Mobile Telebirr QR Reference (${refToUse})`,
      ussdSessionId: telebirrSession?.sessionId,
      ussdDialString: telebirrSession?.ussdDialString,
      traceId: telebirrSession?.traceId,
      autoVerified: true,
    });
    if (receipt) {
      setCheckoutCharge(null);
      setPreviewReceipt(receipt);
    }
  };

  const handleStartArifPay = async () => {
    if (!checkoutCharge) return;
    setPayErrors([]);
    setArifpayBusy(true);
    try {
      const due = Math.max(0, checkoutCharge.billedEtb - checkoutCharge.paidEtb);
      const created = await createArifPayCheckoutSession({
        ownerId: activeOwner.id,
        tenantId,
        tenantName: tenantRecord?.name || activeTenantAccount.displayName,
        unitId: checkoutCharge.unitId,
        chargeId: checkoutCharge.id,
        invoiceNumber: checkoutCharge.invoiceNumber,
        amountEtb: payAmountEtb,
        openBalanceEtb: due,
        msisdn,
        selectedMethod: arifpayMethod,
      });
      if (!created.ok) {
        setPayErrors(created.errors);
        return;
      }
      setArifpaySession(created.session);
      setPaymentReference(created.session.transactionId);
      setCbeRef(created.session.transactionId);
    } finally {
      setArifpayBusy(false);
    }
  };

  const handleCompleteArifPay = async () => {
    if (!checkoutCharge || !arifpaySession) return;
    setPayErrors([]);
    setArifpayBusy(true);
    try {
      const result = await simulateArifPayHostedPayment(
        arifpaySession,
        arifpayMethod,
        arifpayOutcome
      );
      setArifpaySession(result);
      if (result.status !== 'COMPLETED') {
        setPayErrors([result.failureReason || `ArifPay checkout status: ${result.status}`]);
        return;
      }
      const receipt = submitTenantMobilePayment({
        gatewayType: 'ArifPay Checkout',
        tenantId,
        unitId: checkoutCharge.unitId,
        chargeId: checkoutCharge.id,
        amountEtb: result.amountEtb,
        referenceNumber: result.transactionId,
        phoneOrAccount: `${result.msisdn} (${arifpayMethod})`,
        notes: `ArifPay Sandbox Checkout (${arifpayMethod}) · Session ${result.sessionId}`,
        arifpaySessionId: result.sessionId,
        arifpayNonce: result.nonce,
        arifpayMethod,
        autoVerified: true,
      });
      if (receipt) {
        setCheckoutCharge(null);
        setPreviewReceipt(receipt);
      }
    } finally {
      setArifpayBusy(false);
    }
  };

  const handleVerifyArifPayFallback = async () => {
    if (!checkoutCharge || !arifpaySession) return;
    setArifpayBusy(true);
    try {
      const verified = await verifyArifPaySessionFallback(arifpaySession);
      setArifpaySession(verified);
      const receipt = submitTenantMobilePayment({
        gatewayType: 'ArifPay Checkout',
        tenantId,
        unitId: checkoutCharge.unitId,
        chargeId: checkoutCharge.id,
        amountEtb: verified.amountEtb,
        referenceNumber: verified.transactionId,
        phoneOrAccount: `${verified.msisdn} (${verified.selectedMethod})`,
        notes: `ArifPay Verify-by-Session Fallback · ${verified.sessionId}`,
        arifpaySessionId: verified.sessionId,
        arifpayNonce: verified.nonce,
        arifpayMethod: verified.selectedMethod,
        autoVerified: true,
      });
      if (receipt) {
        setCheckoutCharge(null);
        setPreviewReceipt(receipt);
      }
    } finally {
      setArifpayBusy(false);
    }
  };

  const handleSubmitCbeSlip = (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkoutCharge) return;
    const errs: string[] = [];
    if (!payAmountEtb || payAmountEtb <= 0) errs.push('Payment amount must be greater than ETB 0.');
    if (!cbeRef.trim()) errs.push('CBE deposit slip reference is required.');
    if (errs.length > 0) {
      setPayErrors(errs);
      return;
    }
    const receipt = submitTenantMobilePayment({
      gatewayType: 'CBE Transfer Slip',
      tenantId,
      unitId: checkoutCharge.unitId,
      chargeId: checkoutCharge.id,
      amountEtb: payAmountEtb,
      referenceNumber: cbeRef.trim(),
      phoneOrAccount: '1000284910293 (CBE)',
      notes: payNotes.trim() || 'Tenant Mobile CBE Transfer Slip submission',
      autoVerified: false,
    });
    if (receipt) {
      setCheckoutCharge(null);
      setPreviewReceipt(receipt);
    }
  };

  const handleCreateTicket = (e: React.FormEvent) => {
    e.preventDefault();
    const unitId = ticketForm.unitId || myUnits[0]?.id || '';
    const errs: string[] = [];
    if (!unitId) errs.push('No assigned unit found for this tenant.');
    if (!ticketForm.title.trim()) errs.push('Issue summary title is required.');
    if (errs.length > 0) {
      setTicketErrors(errs);
      return;
    }
    const ok = createTenantMaintenanceTicket({
      unitId,
      category: ticketForm.category,
      priority: ticketForm.priority,
      title: ticketForm.title.trim(),
      description: [
        ticketForm.description.trim() || 'Submitted via Tenant Mobile App.',
        repairPhotoFile ? `Photo: ${repairPhotoFile.filename} (${repairPhotoFile.objectKey})` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    if (ok) {
      setRepairPhotoFile(null);
      setNewTicketOpen(false);
      setTicketForm({
        unitId: myUnits[0]?.id || '',
        category: 'Maintenance',
        priority: 'Medium',
        title: '',
        description: '',
      });
      setTicketErrors([]);
    }
  };

  const activeChatTicket = myTickets.find((t) => t.id === chatTicketId) || null;
  const activeChatMessages = activeChatTicket
    ? myVisibleMessages.filter((m) => m.ticketId === activeChatTicket.id)
    : [];

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeChatTicket || !chatInput.trim()) return;
    const sent = sendMaintenanceMessage({
      ticketId: activeChatTicket.id,
      body: chatInput.trim(),
      visibility: 'Shared with Tenant',
      asTenant: true,
    });
    if (sent) setChatInput('');
  };

  return (
    <div
      className="min-h-screen bg-[#F6F7F9] dark:bg-[#0B131E] text-[#0F1D2F] dark:text-slate-100 flex flex-col pb-16 transition-colors"
      data-testid="tenant-mobile-app"
    >
      {/* Compact Sticky Top Header (48px) */}
      <header className="sticky top-0 z-30 h-12 bg-[#0D1D30] text-white px-3 flex items-center justify-between gap-2 border-b border-slate-800">
        <div className="min-w-0 flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#166549] text-white text-[11px] font-bold flex items-center justify-center shrink-0">
            AD
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold truncate leading-tight">
              {tenantRecord?.name || activeTenantAccount.displayName}
            </p>
            <p className="text-[10px] font-mono text-[#E5B85C] truncate leading-tight">
              {activeTenantAccount.unitLabel}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <PWAInstallButton compact showGuideFallback />
          <button
            type="button"
            onClick={() => setLocale(locale === 'en' ? 'am' : 'en')}
            aria-label="Toggle language"
            className="min-h-[36px] px-2 rounded-lg bg-white/10 hover:bg-white/15 text-[11px] font-semibold cursor-pointer"
          >
            {locale === 'en' ? 'አማ' : 'EN'}
          </button>
          <button
            type="button"
            onClick={logoutTenant}
            aria-label="Sign out tenant"
            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-200 cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      <OfflineIndicator />

      {/* Main Mobile Content */}
      <main className="flex-1 w-full max-w-xl mx-auto p-3.5 space-y-4">
        {/* HOME & RENT PULSE */}
        {activeTab === 'home' && (
          <div className="space-y-4">
            <section className="rounded-2xl bg-[#0D1D30] text-white p-4 space-y-3 border border-slate-800 shadow-xs">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] uppercase tracking-wider font-mono text-[#E5B85C]">
                    {biText(locale, 'Tenant Rent Pulse · Demo', 'የተከራይ ኪራይ ሁኔታ · ሙከራ')}
                  </p>
                  <p className="text-2xl font-bold font-mono tabular-nums mt-1">
                    {fmtEtb(totalOpenBalance)}
                  </p>
                  <p className="text-xs text-slate-300 mt-0.5">
                    {totalOpenBalance > 0
                      ? biText(
                          locale,
                          `${myOpenCharges.length} open invoice(s) due`,
                          `${myOpenCharges.length} ክፍት ደረሰኝ(ዎች)`
                        )
                      : biText(locale, 'All rent invoices settled', 'ሁሉም የኪራይ ክፍያዎች ተጠናቀዋል')}
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded-full bg-[#166549] text-white text-[11px] font-semibold">
                  {myUnits.map((u) => u.code).join(', ') || 'Unit'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  disabled={myOpenCharges.length === 0}
                  onClick={() => {
                    if (myOpenCharges[0]) openCheckout(myOpenCharges[0]);
                  }}
                  className="min-h-[44px] rounded-xl bg-[#166549] hover:bg-[#12533B] disabled:opacity-50 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <CreditCard className="w-4 h-4" />
                  <span>{biText(locale, 'Pay Rent Now', 'አሁን ኪራይ ክፈል')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTicketForm((f) => ({ ...f, unitId: myUnits[0]?.id || '' }));
                    setNewTicketOpen(true);
                  }}
                  className="min-h-[44px] rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Wrench className="w-4 h-4 text-[#E5B85C]" />
                  <span>{biText(locale, 'Report Repair', 'ጥገና ጠይቅ')}</span>
                </button>
              </div>
            </section>

            {/* Quick Unit & Lease Summary */}
            <section className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {biText(locale, 'My Assigned Unit & Lease', 'የእኔ ክፍል እና ውል')}
                </h2>
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  {activeOwner.code}
                </span>
              </div>
              {myUnits.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between gap-3 py-2 border-t border-slate-100 dark:border-[#233349]"
                >
                  <div>
                    <p className="text-sm font-bold text-[#0F233A] dark:text-slate-100">
                      {u.code} — {u.name}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Floor {u.floor} · {u.areaSqm} m² · {u.unitType}
                    </p>
                  </div>
                  <StatusLabel label={u.status} />
                </div>
              ))}
              {activeLease && (
                <div className="pt-2 border-t border-slate-100 dark:border-[#233349] flex items-center justify-between text-xs">
                  <span className="text-slate-600 dark:text-slate-400">
                    {activeLease.leaseNumber} ({fmtDate(activeLease.startDate)} →{' '}
                    {fmtDate(activeLease.endDate)})
                  </span>
                  <span className="font-mono font-bold text-[#166549] dark:text-emerald-400">
                    {fmtEtb(activeLease.monthlyRentEtb)}/mo
                  </span>
                </div>
              )}
            </section>

            {/* Recent Notices Preview */}
            <section className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {biText(locale, 'Notices & Alerts', 'ማስታወቂያዎች')}
                </h2>
                <button
                  type="button"
                  onClick={() => setActiveTab('notices')}
                  className="text-xs font-semibold text-[#166549] dark:text-emerald-400 cursor-pointer"
                >
                  {biText(locale, 'View All', 'ሁሉንም እይ')} ({myNotices.length})
                </button>
              </div>
              {myNotices.slice(0, 2).map((n) => (
                <div
                  key={n.id}
                  className="p-3 rounded-xl bg-[#F8FAFC] dark:bg-[#152236] border border-[#DFE5EE] dark:border-[#233349] space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-bold text-[#0F233A] dark:text-slate-100">
                      {locale === 'am' ? n.titleAm : n.titleEn}
                    </p>
                    {!n.readByTenantIds.includes(tenantId) && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 text-[10px] font-semibold">
                        New
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    {locale === 'am' ? n.bodyAm : n.bodyEn}
                  </p>
                </div>
              ))}
            </section>
          </div>
        )}

        {/* INVOICES & MULTI-GATEWAY RECEIPTS */}
        {activeTab === 'pay' && (
          <div className="space-y-4">
            {/* Camera QR Code Scanner Entry Card */}
            <section className="rounded-2xl bg-[#0D1D30] text-white p-4 border border-slate-800 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-bold flex items-center gap-1.5">
                  <QrCode className="w-4 h-4 text-[#E5B85C] shrink-0" />
                  <span>{biText(locale, 'Scan Telebirr / ArifPay QR', 'የቴሌብር / አሪፍፔይ QR ስካን')}</span>
                </p>
                <p className="text-[11px] text-slate-300 mt-0.5">
                  {biText(
                    locale,
                    'Capture a checkout QR with your camera to auto-fill the payment reference.',
                    'የክፍያ ማጣቀሻውን በራስ-ሰር ለመሙላት QR ኮዱን በካሜራ ይቃኙ።'
                  )}
                </p>
              </div>
              <button
                type="button"
                data-testid="open-qr-scanner-btn"
                onClick={() => setQrScannerOpen(true)}
                className="min-h-[44px] px-3.5 rounded-xl bg-[#166549] hover:bg-[#12533B] text-white text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
              >
                <Camera className="w-4 h-4" />
                <span>{biText(locale, 'Scan QR', 'QR ስካን')}</span>
              </button>
            </section>

            <section className="space-y-2.5">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {biText(locale, 'My Invoices', 'የእኔ ደረሰኞች')} ({myCharges.length})
              </h2>
              {myCharges.map((ch) => {
                const due = Math.max(0, ch.billedEtb - ch.paidEtb);
                return (
                  <div
                    key={ch.id}
                    className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-4 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-mono text-xs font-bold text-[#0F233A] dark:text-[#E5B85C]">
                          {ch.invoiceNumber}
                        </p>
                        <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                          {ch.period} · {biText(locale, 'Due', 'መክፈያ')} {fmtDate(ch.dueDate)}
                        </p>
                      </div>
                      <StatusLabel label={ch.status} />
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs bg-[#F8FAFC] dark:bg-[#152236] rounded-xl p-2.5">
                      <div>
                        <p className="text-[10px] text-slate-500 dark:text-slate-400">Billed</p>
                        <p className="font-mono font-semibold tabular-nums">{fmtEtb(ch.billedEtb)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500 dark:text-slate-400">Paid</p>
                        <p className="font-mono font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                          {fmtEtb(ch.paidEtb)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500 dark:text-slate-400">Balance</p>
                        <p className="font-mono font-bold tabular-nums">{fmtEtb(due)}</p>
                      </div>
                    </div>
                    {due > 0 && (
                      <button
                        type="button"
                        onClick={() => openCheckout(ch)}
                        className="w-full min-h-[44px] rounded-xl bg-[#166549] hover:bg-[#12533B] text-white text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <QrCode className="w-4 h-4" />
                        <span>{biText(locale, 'Pay via Telebirr / ArifPay / CBE', 'በቴሌብር / አሪፍፔይ / ንግድ ባንክ ክፈል')}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </section>

            {/* Processed QR Payment History (Scrollable List) & Personal Record Export */}
            <section className="space-y-2.5" data-testid="qr-payment-history-section">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {biText(locale, 'Processed QR Payment History', 'የተከናወኑ የQR ክፍያዎች ታሪክ')} (
                  {myProcessedQrPayments.length})
                </h2>
                <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400">
                  Telebirr · ArifPay
                </span>
              </div>

              {/* Download Processed Payment History (PDF / Excel) */}
              <div
                data-testid="tenant-history-export-bar"
                className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-3.5 space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-[#0F233A] dark:text-slate-100">
                      {biText(locale, 'Download Processed Payment History', 'የተከናወኑ ክፍያዎች ታሪክ አውርድ')}
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {biText(
                        locale,
                        `${myProcessedPaymentHistory.length} processed payment(s) ready for personal record-keeping.`,
                        `ለግል መዝገብ የሚሆኑ ${myProcessedPaymentHistory.length} የተከናወኑ ክፍያዎች ዝግጁ ናቸው።`
                      )}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    data-testid="tenant-download-history-pdf"
                    disabled={myProcessedPaymentHistory.length === 0}
                    onClick={() => handleDownloadPaymentHistory('PDF')}
                    className="min-h-[44px] px-3 rounded-xl bg-[#0F233A] hover:bg-[#173252] dark:bg-[#152236] dark:hover:bg-[#1D2E48] border border-transparent dark:border-[#2D405B] text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-[#E5B85C] shrink-0" />
                    <span>{biText(locale, 'Download PDF', 'PDF አውርድ')}</span>
                  </button>
                  <button
                    type="button"
                    data-testid="tenant-download-history-excel"
                    disabled={myProcessedPaymentHistory.length === 0}
                    onClick={() => handleDownloadPaymentHistory('Excel')}
                    className="min-h-[44px] px-3 rounded-xl bg-[#166549] hover:bg-[#12533B] text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />
                    <span>{biText(locale, 'Excel (.xlsx)', 'Excel (.xlsx)')}</span>
                  </button>
                </div>
                {historyExportMessage && (
                  <p
                    data-testid="tenant-history-export-status"
                    className="text-[11px] text-emerald-700 dark:text-emerald-300 font-medium"
                  >
                    {historyExportMessage}
                  </p>
                )}
              </div>

              {myProcessedQrPayments.length === 0 ? (
                <div className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-4 text-xs text-slate-500 dark:text-slate-400">
                  {biText(
                    locale,
                    'No processed QR payments yet. Scan or settle a Telebirr or ArifPay QR payment to see it logged here.',
                    'እስካሁን የተከናወነ የQR ክፍያ የለም። የቴሌብር ወይም አሪፍፔይ QR ክፍያ ሲፈጽሙ እዚህ ይታያል።'
                  )}
                </div>
              ) : (
                <div
                  data-testid="qr-payment-history-list"
                  className="max-h-60 overflow-y-auto space-y-2 pr-1"
                >
                  {myProcessedQrPayments.map((item) => (
                    <div
                      key={item.id}
                      data-testid="qr-payment-history-item"
                      className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-3.5 space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-[#0F233A] dark:text-slate-100 truncate">
                          {item.gatewayType}
                          {item.invoiceNumber ? ` · ${item.invoiceNumber}` : ''}
                        </span>
                        <StatusLabel label={item.status} />
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-mono text-slate-600 dark:text-slate-300 truncate">
                          {biText(locale, 'Ref:', 'ማጣቀሻ:')} {item.referenceNumber}
                        </span>
                        <span className="font-mono font-bold tabular-nums text-[#166549] dark:text-emerald-400 shrink-0">
                          {fmtEtb(item.amountEtb)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400">
                        <span className="font-mono tabular-nums">{fmtDateTime(item.date)}</span>
                        {item.receipt && (
                          <button
                            type="button"
                            onClick={() => setPreviewReceipt(item.receipt!)}
                            className="font-semibold text-[#166549] dark:text-emerald-400 hover:underline cursor-pointer"
                          >
                            {biText(locale, 'Receipt', 'ደረሰኝ')}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-2.5">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {biText(locale, 'DEMO Payment Receipts', 'የሙከራ (DEMO) ደረሰኞች')} ({myReceipts.length})
              </h2>
              {myReceipts.map((r) => (
                <div
                  key={r.id}
                  className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-3.5 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-bold text-[#0F233A] dark:text-[#E5B85C] truncate">
                      {r.receiptNumber}
                    </p>
                    <p className="text-xs text-slate-600 dark:text-slate-300 truncate">
                      {r.method} · {fmtDate(r.paymentDate)}
                    </p>
                  </div>
                  <div className="text-right shrink-0 space-y-1">
                    <p className="font-mono text-xs font-bold tabular-nums">{fmtEtb(r.amountEtb)}</p>
                    <button
                      type="button"
                      onClick={() => setPreviewReceipt(r)}
                      className="text-[11px] font-semibold text-[#166549] dark:text-emerald-400 hover:underline cursor-pointer"
                    >
                      {biText(locale, 'View DEMO Receipt', 'ደረሰኝ እይ')}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          </div>
        )}

        {/* REPAIRS & LIVE 2-WAY CHAT */}
        {activeTab === 'repairs' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {biText(locale, 'Repairs & Complaints', 'ጥገናዎችና ቅሬታዎች')} ({myTickets.length})
              </h2>
              <button
                type="button"
                onClick={() => {
                  setTicketForm((f) => ({ ...f, unitId: myUnits[0]?.id || '' }));
                  setNewTicketOpen(true);
                }}
                className="min-h-[40px] px-3.5 rounded-xl bg-[#166549] text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>{biText(locale, 'New Request', 'አዲስ ጥያቄ')}</span>
              </button>
            </div>

            {myTickets.length === 0 ? (
              <div className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                {biText(locale, 'No maintenance tickets yet.', 'ምንም የጥገና ጥያቄ የለም።')}
              </div>
            ) : (
              myTickets.map((t) => {
                const msgCount = myVisibleMessages.filter((m) => m.ticketId === t.id).length;
                return (
                  <div
                    key={t.id}
                    className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-4 space-y-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                          {t.ticketNumber} · {t.category}
                        </p>
                        <p className="text-sm font-bold text-[#0F233A] dark:text-slate-100 mt-0.5">
                          {t.title}
                        </p>
                      </div>
                      <StatusLabel label={t.workOrderState} />
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-300">{t.description}</p>
                    <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-[#233349]">
                      <StatusLabel label={t.priority} />
                      <button
                        type="button"
                        onClick={() => setChatTicketId(t.id)}
                        className="min-h-[40px] px-3 rounded-xl bg-[#0F233A] dark:bg-[#162438] text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <MessageSquare className="w-3.5 h-3.5 text-[#E5B85C]" />
                        <span>
                          {biText(locale, 'Chat with Office', 'ከቢሮ ጋር ተወያይ')} ({msgCount})
                        </span>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* NOTICES & AUTOMATED SMS INBOX */}
        {activeTab === 'notices' && (
          <div className="space-y-4">
            <section className="space-y-2.5">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {biText(locale, 'Official Management Notices', 'የአስተዳደር ማስታወቂያዎች')} ({myNotices.length})
              </h2>
              {myNotices.map((n) => {
                const isRead = n.readByTenantIds.includes(tenantId);
                return (
                  <div
                    key={n.id}
                    className={`rounded-2xl border p-4 space-y-2 ${
                      isRead
                        ? 'bg-white dark:bg-[#111C2C] border-[#DFE5EE] dark:border-[#233349]'
                        : 'bg-amber-50/60 dark:bg-amber-950/20 border-amber-300 dark:border-amber-700/60'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="text-[10px] font-mono uppercase text-[#166549] dark:text-emerald-400 font-semibold">
                          {n.category} · {fmtDateTime(n.publishedAt)}
                        </span>
                        <h3 className="text-sm font-bold text-[#0F233A] dark:text-slate-100 mt-0.5">
                          {locale === 'am' ? n.titleAm : n.titleEn}
                        </h3>
                      </div>
                      {!isRead && (
                        <button
                          type="button"
                          onClick={() => markTenantNoticeRead(n.id, tenantId)}
                          className="min-h-[36px] px-2.5 rounded-lg bg-[#166549] text-white text-[11px] font-semibold cursor-pointer shrink-0"
                        >
                          {biText(locale, 'Mark Read', 'ተነቧል')}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                      {locale === 'am' ? n.bodyAm : n.bodyEn}
                    </p>
                  </div>
                );
              })}
            </section>

            <section className="space-y-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {biText(locale, 'Automated SMS Alert Log', 'አውቶማቲክ የSMS መልዕክቶች')} ({mySmsLogs.length})
                </h2>
                <span className="text-[10px] font-mono text-amber-700 dark:text-amber-300">
                  SANDBOX DISPATCH
                </span>
              </div>
              {mySmsLogs.length === 0 ? (
                <div className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-4 text-xs text-slate-500 dark:text-slate-400">
                  {biText(locale, 'No automated SMS alerts sent yet.', 'እስካሁን የተላከ SMS የለም።')}
                </div>
              ) : (
                mySmsLogs.map((sms) => (
                  <div
                    key={sms.id}
                    className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-3.5 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-semibold text-[#0F233A] dark:text-[#E5B85C]">
                        {sms.triggerType}
                      </span>
                      <span className="font-mono text-slate-500 dark:text-slate-400">
                        {sms.recipientMsisdn} · {sms.deliveryState}
                      </span>
                    </div>
                    <p className="text-xs text-slate-700 dark:text-slate-300">{sms.messageBody}</p>
                    <p className="text-[10px] font-mono text-slate-400">
                      {fmtDateTime(sms.dispatchedAt)}
                    </p>
                  </div>
                ))
              )}
            </section>
          </div>
        )}

        {/* LEASE & DOCUMENTS + PROFILE & PREFERENCES */}
        {activeTab === 'account' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-200/80 dark:bg-[#152236] rounded-xl">
              <button
                type="button"
                onClick={() => setAccountSubView('docs')}
                className={`min-h-[40px] rounded-lg text-xs font-semibold cursor-pointer ${
                  accountSubView === 'docs'
                    ? 'bg-white dark:bg-[#0D1D30] text-[#0F233A] dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                {biText(locale, 'Lease & Documents', 'ውል እና ሰነዶች')}
              </button>
              <button
                type="button"
                onClick={() => setAccountSubView('profile')}
                className={`min-h-[40px] rounded-lg text-xs font-semibold cursor-pointer ${
                  accountSubView === 'profile'
                    ? 'bg-white dark:bg-[#0D1D30] text-[#0F233A] dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                {biText(locale, 'Profile & Alerts', 'መገለጫ እና ማንቂያ')}
              </button>
            </div>

            {accountSubView === 'docs' ? (
              <div className="space-y-3">
                {myLeases.map((l) => {
                  const unit = myUnits.find((u) => u.id === l.unitId);
                  return (
                    <div
                      key={l.id}
                      className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-4 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-mono text-xs font-bold text-[#0F233A] dark:text-[#E5B85C]">
                          {l.leaseNumber} (v{l.version})
                        </p>
                        <StatusLabel label={l.status} />
                      </div>
                      <p className="text-xs font-semibold">
                        {unit?.code || l.unitId} · {fmtEtb(l.monthlyRentEtb)}/month
                      </p>
                      <p className="text-xs text-slate-600 dark:text-slate-400">
                        Term: {fmtDate(l.startDate)} → {fmtDate(l.endDate)} · Deposit:{' '}
                        {fmtEtb(l.securityDepositEtb)}
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        Evidence Ref: <span className="font-mono">{l.evidenceRef}</span>
                      </p>
                    </div>
                  );
                })}
                {tenantRecord && (
                  <div className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-4 space-y-1.5 text-xs">
                    <p className="font-bold text-[#0F233A] dark:text-slate-100 flex items-center gap-1.5">
                      <FileText className="w-4 h-4 text-[#166549] dark:text-emerald-400" />
                      <span>{biText(locale, 'Synthetic Tenant Vault Identifiers', 'ሰው-ሠራሽ የተከራይ ሰነድ መለያዎች')}</span>
                    </p>
                    <p className="text-slate-600 dark:text-slate-300">
                      ID Placeholder: <span className="font-mono">{tenantRecord.idPlaceholder}</span>
                    </p>
                    <p className="text-slate-600 dark:text-slate-300">
                      Business Type: {tenantRecord.businessType}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-2xl bg-white dark:bg-[#111C2C] border border-[#DFE5EE] dark:border-[#233349] p-4 space-y-4 text-xs">
                <div>
                  <label className="font-semibold block mb-1">
                    {biText(locale, 'SMS & Telebirr MSISDN', 'የSMS እና ቴሌብር ስልክ ቁጥር')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      value={msisdnDraft}
                      onChange={(e) => setMsisdnDraft(e.target.value)}
                      className="flex-1 px-3 py-2.5 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236] font-mono"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        updateTenantNotificationPrefs(tenantId, { msisdn: msisdnDraft })
                      }
                      className="min-h-[44px] px-4 rounded-xl bg-[#166549] text-white font-semibold cursor-pointer"
                    >
                      {biText(locale, 'Save', 'አስቀምጥ')}
                    </button>
                  </div>
                </div>

                <label className="flex items-center justify-between gap-3 py-2 border-t border-slate-100 dark:border-[#233349] cursor-pointer">
                  <span>{biText(locale, 'Automated SMS Rent & Repair Alerts', 'አውቶማቲክ የSMS ኪራይና ጥገና ማንቂያዎች')}</span>
                  <input
                    type="checkbox"
                    checked={myPrefs.smsEnabled}
                    onChange={(e) =>
                      updateTenantNotificationPrefs(tenantId, { smsEnabled: e.target.checked })
                    }
                    className="w-5 h-5"
                  />
                </label>

                <div className="py-2 border-t border-slate-100 dark:border-[#233349] space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold">
                        {biText(locale, 'Background OS Web Push (VAPID)', 'ከመተግበሪያው ውጭ የWeb Push ማሳወቂያ')}
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {webPush.subscribed
                          ? biText(locale, 'Subscribed on this device', 'በዚህ መሣሪያ ላይ ነቅቷል')
                          : biText(locale, 'Receive alerts even when the PWA is closed', 'መተግበሪያው ሲዘጋም ማንቂያ ይቀበሉ')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {webPush.subscribed && (
                        <button
                          type="button"
                          disabled={webPush.busy}
                          onClick={() => void webPush.sendTestPush(activeOwner.id)}
                          className="min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer whitespace-nowrap"
                        >
                          {biText(locale, 'Test Push', 'ሙከራ ላክ')}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={webPush.busy}
                        onClick={() => {
                          if (webPush.subscribed) {
                            void webPush.disablePush();
                            updateTenantNotificationPrefs(tenantId, { pushEnabled: false });
                          } else {
                            void webPush.enablePush().then((ok) => {
                              if (ok) updateTenantNotificationPrefs(tenantId, { pushEnabled: true });
                            });
                          }
                        }}
                        className={`min-h-[44px] px-3.5 rounded-xl text-xs font-semibold cursor-pointer whitespace-nowrap ${
                          webPush.subscribed
                            ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200'
                            : 'bg-[#0F233A] text-white dark:bg-[#166549]'
                        }`}
                      >
                        {webPush.busy
                          ? '…'
                          : webPush.subscribed
                            ? biText(locale, 'Disable Push', 'አጥፋ')
                            : biText(locale, 'Enable Push', 'አንቃ')}
                      </button>
                    </div>
                  </div>
                  {webPush.statusMessage && (
                    <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
                      {webPush.statusMessage}
                    </p>
                  )}
                  {webPush.error && (
                    <p className="text-[11px] text-red-700 dark:text-red-300">{webPush.error}</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 dark:border-[#233349]">
                  <button
                    type="button"
                    onClick={() => setLocale(locale === 'en' ? 'am' : 'en')}
                    className="min-h-[44px] rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] flex items-center justify-center gap-1.5 font-semibold cursor-pointer"
                  >
                    <Globe className="w-4 h-4" />
                    <span>{locale === 'en' ? 'አማርኛ' : 'English'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={toggleTheme}
                    className="min-h-[44px] rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] flex items-center justify-center gap-1.5 font-semibold cursor-pointer"
                  >
                    {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
                    <span>{theme === 'light' ? 'Dark Slate' : 'Daylight'}</span>
                  </button>
                </div>

                <div>
                  <label className="font-semibold block mb-1">
                    {biText(locale, 'Calendar Display Mode', 'የቀን መቁጠሪያ ዘዴ')}
                  </label>
                  <select
                    value={dateMode}
                    onChange={(e) => setDateMode(e.target.value as DateDisplayMode)}
                    className="w-full min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236]"
                  >
                    <option value="dual">Dual (Ethiopian + Gregorian)</option>
                    <option value="ethiopic">Ethiopian (ዓ.ም)</option>
                    <option value="gregorian">Gregorian</option>
                  </select>
                </div>

                <div className="pt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 dark:border-[#233349]">
                  <PWAInstallButton showGuideFallback />
                  <button
                    type="button"
                    onClick={logoutTenant}
                    className="min-h-[44px] px-4 rounded-xl bg-red-600 hover:bg-red-700 text-white font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>{biText(locale, 'Sign Out', 'ውጣ')}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Fixed Bottom Navigation Bar (56px) */}
      <nav
        aria-label="Tenant mobile navigation"
        className="fixed bottom-0 inset-x-0 z-30 h-14 bg-white dark:bg-[#111C2C] border-t border-[#DFE5EE] dark:border-[#233349] grid grid-cols-5"
      >
        {(
          [
            { id: 'home', label: biText(locale, 'Home', 'መነሻ'), icon: Home },
            { id: 'pay', label: biText(locale, 'Pay', 'ክፍያ'), icon: CreditCard },
            { id: 'repairs', label: biText(locale, 'Repairs', 'ጥገና'), icon: Wrench },
            {
              id: 'notices',
              label: biText(locale, 'Notices', 'ማስታወቂያ'),
              icon: Bell,
              badge: unreadNoticesCount,
            },
            { id: 'account', label: biText(locale, 'Account', 'መለያ'), icon: User },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold relative cursor-pointer ${
                active
                  ? 'text-[#166549] dark:text-emerald-400'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
              {'badge' in item && item.badge ? (
                <span className="absolute top-1.5 right-3 min-w-[16px] h-4 px-1 rounded-full bg-[#C28A24] text-slate-950 text-[9px] font-bold flex items-center justify-center">
                  {item.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* Multi-Gateway Checkout BottomSheet */}
      <BottomSheet
        open={Boolean(checkoutCharge)}
        onClose={() => setCheckoutCharge(null)}
        title={
          checkoutCharge
            ? `${biText(locale, 'Pay Invoice', 'ደረሰኝ ክፈል')} · ${checkoutCharge.invoiceNumber}`
            : ''
        }
        subtitle={biText(
          locale,
          'Sandbox Multi-Gateway Simulation — DEMO Receipt Only',
          'የሙከራ መድረክ ክፍያ — የDEMO ደረሰኝ ብቻ'
        )}
      >
        {checkoutCharge && (
          <div className="space-y-4 text-xs">
            <ValidationSummary errors={payErrors} />

            {qrScanBanner && (
              <div
                role="status"
                className="rounded-xl border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 p-2.5 flex items-center gap-2 text-emerald-900 dark:text-emerald-200 text-[11px] font-medium"
              >
                <CheckCircle2 className="w-4 h-4 shrink-0 text-[#166549] dark:text-emerald-400" />
                <span className="truncate">{qrScanBanner}</span>
              </div>
            )}

            {/* Gateway Tabs */}
            <div className="grid grid-cols-3 gap-2">
              {(['Telebirr USSD QR', 'ArifPay Checkout', 'CBE Transfer Slip'] as const).map((gw) => (
                <button
                  key={gw}
                  type="button"
                  onClick={() => {
                    setGateway(gw);
                    setPayErrors([]);
                  }}
                  className={`min-h-[44px] p-2 rounded-xl border text-[11px] font-bold text-center cursor-pointer ${
                    gateway === gw
                      ? 'border-[#166549] bg-emerald-50/70 dark:bg-emerald-950/30 text-[#166549] dark:text-emerald-300'
                      : 'border-[#DFE5EE] dark:border-[#233349] text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {gw === 'Telebirr USSD QR'
                    ? 'Telebirr QR'
                    : gw === 'ArifPay Checkout'
                      ? 'ArifPay'
                      : 'CBE Slip'}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block font-semibold mb-1">Amount (ETB)</label>
                <input
                  type="number"
                  min={1}
                  value={payAmountEtb || ''}
                  onChange={(e) => setPayAmountEtb(Number(e.target.value))}
                  className="w-full min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236] font-mono tabular-nums"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">MSISDN</label>
                <input
                  type="text"
                  value={msisdn}
                  onChange={(e) => setMsisdn(e.target.value)}
                  className="w-full min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236] font-mono"
                />
              </div>
            </div>

            {/* Auto-Populated Gateway / QR Reference Field */}
            {gateway !== 'CBE Transfer Slip' && (
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label htmlFor="checkout-payment-reference" className="block font-semibold">
                    {biText(locale, 'Payment / QR Reference', 'የክፍያ / QR ማጣቀሻ')}
                  </label>
                  <button
                    type="button"
                    onClick={() => setQrScannerOpen(true)}
                    className="text-[11px] font-semibold text-[#166549] dark:text-emerald-400 inline-flex items-center gap-1 hover:underline cursor-pointer"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span>{biText(locale, 'Scan QR', 'QR ስካን')}</span>
                  </button>
                </div>
                <input
                  id="checkout-payment-reference"
                  type="text"
                  value={paymentReference}
                  onChange={(e) => {
                    setPaymentReference(e.target.value);
                    setCbeRef(e.target.value);
                  }}
                  placeholder="TEL-QR-... or AP-SESS-... (auto-filled by QR scan)"
                  className="w-full min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236] font-mono"
                />
              </div>
            )}

            {gateway === 'Telebirr USSD QR' && (
              <div className="space-y-3">
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Merchant {TELEBIRR_SANDBOX_CONFIG.merchantCode} · USSD{' '}
                  {TELEBIRR_SANDBOX_CONFIG.ussdShortCode}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handleGenerateTelebirrQr}
                    className="min-h-[44px] rounded-xl border border-[#166549] text-[#166549] dark:text-emerald-300 font-semibold cursor-pointer"
                  >
                    Generate USSD QR
                  </button>
                  <button
                    type="button"
                    onClick={handleTelebirrQuickPay}
                    className="min-h-[44px] rounded-xl bg-[#166549] text-white font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Zap className="w-4 h-4" />
                    <span>1-Tap Mock Telebirr</span>
                  </button>
                </div>
                {paymentReference.trim() && (
                  <button
                    type="button"
                    onClick={handleSettleTelebirrReference}
                    className="w-full min-h-[44px] rounded-xl bg-[#0F233A] dark:bg-[#166549] text-white font-semibold cursor-pointer"
                  >
                    {biText(
                      locale,
                      `Confirm & Settle Reference (${paymentReference.trim()})`,
                      `ማጣቀሻውን አረጋግጥና ክፈል (${paymentReference.trim()})`
                    )}
                  </button>
                )}
                {telebirrSession && (
                  <div className="rounded-xl bg-[#F8FAFC] dark:bg-[#152236] border border-[#DFE5EE] dark:border-[#233349] p-3 flex flex-col sm:flex-row items-center gap-3">
                    {telebirrQrDataUrl && (
                      <img
                        src={telebirrQrDataUrl}
                        alt={`Telebirr payment QR for ${telebirrSession.invoiceNumber}`}
                        className="w-32 h-32 rounded-lg border border-[#DFE5EE] bg-white p-1 shrink-0"
                      />
                    )}
                    <div className="min-w-0 space-y-1 text-[11px] font-mono w-full">
                      <p className="font-bold">{telebirrSession.sessionId}</p>
                      <p>Ref: {telebirrSession.transactionRef}</p>
                      <p>Dial: {telebirrSession.ussdDialString}</p>
                      <p>Trace: {telebirrSession.traceId}</p>
                      <p className="text-[10px] text-slate-500 break-all">
                        {buildTelebirrQrPayload(telebirrSession)}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {gateway === 'ArifPay Checkout' && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block font-semibold mb-1">ArifPay Method</label>
                    <select
                      value={arifpayMethod}
                      onChange={(e) => setArifpayMethod(e.target.value as ArifPaySelectedMethod)}
                      className="w-full min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236]"
                    >
                      <option value="TELEBIRR">TELEBIRR Wallet</option>
                      <option value="CBE">CBE Direct</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-semibold mb-1">Sandbox Outcome</label>
                    <select
                      value={arifpayOutcome}
                      onChange={(e) => setArifpayOutcome(e.target.value as ArifPayOutcome)}
                      className="w-full min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236]"
                    >
                      <option value="COMPLETED">COMPLETED (Webhook)</option>
                      <option value="CANCELLED">CANCELLED</option>
                      <option value="FAILED">FAILED</option>
                    </select>
                  </div>
                </div>

                {!arifpaySession ? (
                  <button
                    type="button"
                    disabled={arifpayBusy}
                    onClick={handleStartArifPay}
                    className="w-full min-h-[44px] rounded-xl bg-[#0F233A] dark:bg-[#166549] text-white font-semibold cursor-pointer"
                  >
                    {arifpayBusy ? 'Creating ArifPay Session…' : 'Create ArifPay Hosted Checkout'}
                  </button>
                ) : (
                  <div className="rounded-xl bg-[#F8FAFC] dark:bg-[#152236] border border-[#DFE5EE] dark:border-[#233349] p-3 space-y-2.5">
                    <div className="flex flex-col sm:flex-row items-center gap-3">
                      {arifpayQrDataUrl && (
                        <img
                          src={arifpayQrDataUrl}
                          alt={`ArifPay checkout QR for ${arifpaySession.invoiceNumber}`}
                          className="w-32 h-32 rounded-lg border border-[#DFE5EE] bg-white p-1 shrink-0"
                        />
                      )}
                      <div className="min-w-0 w-full space-y-1">
                        <p className="font-mono text-[11px] font-bold">{arifpaySession.sessionId}</p>
                        <p className="font-mono text-[11px]">TX: {arifpaySession.transactionId}</p>
                        <p className="font-mono text-[10px] text-slate-500 break-all">
                          {buildArifPayQrPayload(arifpaySession)}
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={arifpayBusy}
                        onClick={handleCompleteArifPay}
                        className="min-h-[44px] rounded-xl bg-[#166549] text-white font-semibold cursor-pointer"
                      >
                        Authorize & Settle
                      </button>
                      <button
                        type="button"
                        disabled={arifpayBusy}
                        onClick={handleVerifyArifPayFallback}
                        className="min-h-[44px] rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] font-semibold cursor-pointer"
                      >
                        Verify Session
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {gateway === 'CBE Transfer Slip' && (
              <form onSubmit={handleSubmitCbeSlip} className="space-y-3">
                <div>
                  <label className="block font-semibold mb-1">CBE Deposit Slip Reference *</label>
                  <input
                    type="text"
                    required
                    value={cbeRef}
                    onChange={(e) => setCbeRef(e.target.value)}
                    placeholder="e.g. CBE-MOB-88120"
                    className="w-full min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Branch / Transfer Note</label>
                  <input
                    type="text"
                    value={payNotes}
                    onChange={(e) => setPayNotes(e.target.value)}
                    placeholder="Bole branch slip"
                    className="w-full min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236]"
                  />
                </div>
                <DocumentUploadField
                  entityType="CBE_SLIP"
                  entityRefId={checkoutCharge.id}
                  ownerId={activeOwner.id}
                  label={biText(locale, 'Attach CBE Slip Photo / PDF', 'የCBE ደረሰኝ ፎቶ / PDF ያያይዙ')}
                  value={cbeSlipFile}
                  onChange={(file) => {
                    setCbeSlipFile(file);
                    if (file && !payNotes.trim()) {
                      setPayNotes(`Slip uploaded: ${file.filename}`);
                    }
                  }}
                />
                <button
                  type="submit"
                  className="w-full min-h-[44px] rounded-xl bg-[#C28A24] text-slate-950 font-semibold cursor-pointer"
                >
                  Submit CBE Slip for Verification
                </button>
              </form>
            )}
          </div>
        )}
      </BottomSheet>

      {/* DEMO Receipt Preview Sheet */}
      <BottomSheet
        open={Boolean(previewReceipt)}
        onClose={() => setPreviewReceipt(null)}
        title={previewReceipt ? `${previewReceipt.receiptNumber} (DEMO)` : ''}
        subtitle="DEMO — NOT A TAX INVOICE OR FISCAL RECEIPT"
      >
        {previewReceipt && (
          <div className="space-y-3 text-xs">
            <div className="p-2.5 rounded-lg border-2 border-red-600 text-red-700 dark:text-red-300 font-mono text-center font-bold">
              DEMO — NOT A TAX INVOICE — SYNTHETIC DATA
            </div>
            <dl className="grid grid-cols-2 gap-2.5 bg-[#F8FAFC] dark:bg-[#152236] p-3 rounded-xl border border-[#DFE5EE] dark:border-[#233349]">
              <div>
                <dt className="text-slate-500">Amount</dt>
                <dd className="font-mono font-bold tabular-nums">{fmtEtb(previewReceipt.amountEtb)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Method</dt>
                <dd className="font-semibold">{previewReceipt.method}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Date</dt>
                <dd className="font-mono">{fmtDate(previewReceipt.paymentDate)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Reference</dt>
                <dd className="font-mono truncate">{previewReceipt.referencePlaceholder}</dd>
              </div>
            </dl>
            <button
              type="button"
              onClick={() => setPreviewReceipt(null)}
              className="w-full min-h-[44px] rounded-xl bg-[#0F233A] dark:bg-[#166549] text-white font-semibold cursor-pointer"
            >
              {biText(locale, 'Done', 'ተጠናቋል')}
            </button>
          </div>
        )}
      </BottomSheet>

      {/* New Maintenance Ticket Sheet */}
      <BottomSheet
        open={newTicketOpen}
        onClose={() => setNewTicketOpen(false)}
        title={biText(locale, 'Submit Repair / Complaint', 'የጥገና / ቅሬታ ጥያቄ አስገባ')}
      >
        <form onSubmit={handleCreateTicket} className="space-y-3 text-xs">
          <ValidationSummary errors={ticketErrors} />
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block font-semibold mb-1">Unit</label>
              <select
                value={ticketForm.unitId || myUnits[0]?.id || ''}
                onChange={(e) => setTicketForm({ ...ticketForm, unitId: e.target.value })}
                className="w-full min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236]"
              >
                {myUnits.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-semibold mb-1">Priority</label>
              <select
                value={ticketForm.priority}
                onChange={(e) =>
                  setTicketForm({
                    ...ticketForm,
                    priority: e.target.value as 'Low' | 'Medium' | 'High' | 'Urgent',
                  })
                }
                className="w-full min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236]"
              >
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Urgent">Urgent</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block font-semibold mb-1">Issue Title *</label>
            <input
              required
              value={ticketForm.title}
              onChange={(e) => setTicketForm({ ...ticketForm, title: e.target.value })}
              placeholder="e.g. Leaking sink pipe"
              className="w-full min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236]"
            />
          </div>
          <div>
            <label className="block font-semibold mb-1">Details</label>
            <textarea
              rows={3}
              value={ticketForm.description}
              onChange={(e) => setTicketForm({ ...ticketForm, description: e.target.value })}
              className="w-full p-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236]"
            />
          </div>
          <DocumentUploadField
            entityType="REPAIR_PHOTO"
            entityRefId={ticketForm.unitId || myUnits[0]?.id || ''}
            ownerId={activeOwner.id}
            label={biText(locale, 'Attach Repair Photo (Optional)', 'የጥገና ፎቶ ያያይዙ (አማራጭ)')}
            value={repairPhotoFile}
            onChange={setRepairPhotoFile}
          />
          <button
            type="submit"
            className="w-full min-h-[44px] rounded-xl bg-[#166549] text-white font-semibold cursor-pointer"
          >
            {biText(locale, 'Submit Request', 'ጥያቄውን ላክ')}
          </button>
        </form>
      </BottomSheet>

      {/* Live 2-Way Maintenance Chat Sheet (Strictly Shared Messages Only) */}
      <BottomSheet
        open={Boolean(activeChatTicket)}
        onClose={() => setChatTicketId(null)}
        title={activeChatTicket ? `${activeChatTicket.ticketNumber} · Chat` : ''}
        subtitle={activeChatTicket?.title}
      >
        {activeChatTicket && (
          <div className="space-y-3 text-xs">
            <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
              {activeChatMessages.length === 0 ? (
                <p className="text-slate-500 text-center py-6">
                  {biText(locale, 'No messages yet. Send a message to Property Management.', 'እስካሁን መልዕክት የለም። ለንብረት አስተዳደር ይጻፉ።')}
                </p>
              ) : (
                activeChatMessages.map((msg) => {
                  const isMine = msg.senderRole === 'Tenant';
                  return (
                    <div
                      key={msg.id}
                      className={`p-3 rounded-2xl ${
                        isMine
                          ? 'bg-[#166549] text-white ml-6'
                          : 'bg-[#F4F6F9] dark:bg-[#152236] border border-[#DFE5EE] dark:border-[#233349] mr-6'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[10px] opacity-80 mb-1">
                        <span className="font-semibold">{msg.senderName}</span>
                        <span className="font-mono">{fmtDateTime(msg.timestamp)}</span>
                      </div>
                      <p>{msg.body}</p>
                    </div>
                  );
                })
              )}
            </div>

            <form onSubmit={handleSendChat} className="flex gap-2 pt-2 border-t border-[#DFE5EE] dark:border-[#233349]">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder={biText(locale, 'Write a reply to management…', 'ለአስተዳደሩ መልስ ይጻፉ…')}
                className="flex-1 min-h-[44px] px-3 rounded-xl border border-[#CBD5E1] dark:border-[#2D405B] bg-[#F8FAFC] dark:bg-[#152236]"
              />
              <button
                type="submit"
                aria-label="Send message"
                className="min-h-[44px] min-w-[44px] px-3.5 rounded-xl bg-[#166549] text-white flex items-center justify-center cursor-pointer"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        )}
      </BottomSheet>

      {/* Camera QR Scanner Sheet */}
      <PaymentQrScannerSheet
        open={qrScannerOpen}
        onClose={() => setQrScannerOpen(false)}
        onDecoded={handleQrDecoded}
        matchInvoice={matchQrToInvoice}
        locale={locale}
      />

      {/* Toasts */}
      {toasts.length > 0 && (
        <div className="fixed top-14 right-3 z-50 space-y-2 w-72 max-w-[calc(100vw-1.5rem)]">
          {toasts.map((t) => (
            <div
              key={t.id}
              onClick={() => dismissToast(t.id)}
              className="rounded-xl border border-[#DFE5EE] dark:border-[#233349] bg-white dark:bg-[#111C2C] p-3 shadow-lg text-xs cursor-pointer"
            >
              <p className="font-bold">{t.title}</p>
              {t.detail && <p className="text-slate-600 dark:text-slate-300 mt-0.5">{t.detail}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
