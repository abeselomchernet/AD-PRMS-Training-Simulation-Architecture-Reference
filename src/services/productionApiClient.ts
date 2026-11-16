import { OwnerId } from '../types/prms';

export type AppRuntimeMode = 'training' | 'production';

export const APP_RUNTIME_MODE: AppRuntimeMode =
  import.meta.env.VITE_APP_MODE === 'production' ? 'production' : 'training';

export const API_BASE_URL: string = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
export const WS_BASE_URL: string = String(import.meta.env.VITE_WS_BASE_URL || '').replace(/\/+$/, '');
export const ENV_VAPID_PUBLIC_KEY: string = String(import.meta.env.VITE_VAPID_PUBLIC_KEY || '');

const TOKEN_STORAGE_KEY = 'adprms.prod.jwt';

export interface StoredJwtTokens {
  access: string;
  refresh: string;
}

export interface ApiUserProfile {
  id: string;
  username: string;
  actor_id: string;
  user_type: 'STAFF' | 'TENANT';
  role: string;
  phone_msisdn: string;
  owner_code: OwnerId;
  allowed_owners: OwnerId[];
  tenant_id_ref: string | null;
  mfa_enabled: boolean;
  preferred_locale: 'en' | 'am';
}

export interface ErcaGateStatus {
  erca_tin_verified: boolean;
  vat_certificate_verified: boolean;
  adviser_signed_off: boolean;
  owner_activation_approved: boolean;
  live_tax_enabled: boolean;
  can_activate_tax_rules: boolean;
}

export function isProductionApiConfigured(): boolean {
  return APP_RUNTIME_MODE === 'production' || Boolean(API_BASE_URL);
}

export function getStoredJwtTokens(): StoredJwtTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredJwtTokens) : null;
  } catch {
    return null;
  }
}

export function setStoredJwtTokens(tokens: StoredJwtTokens | null): void {
  try {
    if (!tokens) localStorage.removeItem(TOKEN_STORAGE_KEY);
    else localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
  } catch {
    // Ignore storage errors cleanly
  }
}

function resolveApiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

async function refreshJwtAccessToken(): Promise<string | null> {
  const tokens = getStoredJwtTokens();
  if (!tokens?.refresh) return null;
  try {
    const res = await fetch(resolveApiUrl('/api/v1/auth/token/refresh/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: tokens.refresh }),
    });
    if (!res.ok) {
      setStoredJwtTokens(null);
      return null;
    }
    const data = (await res.json()) as { access: string; refresh?: string };
    setStoredJwtTokens({ access: data.access, refresh: data.refresh || tokens.refresh });
    return data.access;
  } catch {
    return null;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { ownerContext?: OwnerId; skipAuth?: boolean } = {}
): Promise<T> {
  const { ownerContext, skipAuth, headers, ...rest } = options;
  const tokens = skipAuth ? null : getStoredJwtTokens();

  const buildHeaders = (accessToken?: string): HeadersInit => ({
    'Content-Type': 'application/json',
    ...(ownerContext ? { 'X-Owner-Context': ownerContext } : {}),
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(headers || {}),
  });

  let response = await fetch(resolveApiUrl(path), {
    ...rest,
    headers: buildHeaders(tokens?.access),
  });

  if (response.status === 401 && !skipAuth && tokens?.refresh) {
    const nextAccess = await refreshJwtAccessToken();
    if (nextAccess) {
      response = await fetch(resolveApiUrl(path), {
        ...rest,
        headers: buildHeaders(nextAccess),
      });
    }
  }

  if (!response.ok) {
    let message = `API request failed (${response.status})`;
    try {
      const errBody = (await response.json()) as { detail?: string; msg?: string };
      message = errBody.detail || errBody.msg || message;
    } catch {
      // Ignore parse error
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return {} as T;
  }
  return (await response.json()) as T;
}

export async function requestTenantOtp(msisdn: string, locale: 'en' | 'am') {
  return apiRequest<{ ok: boolean; detail: string }>('/api/v1/auth/tenant/otp/request/', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify({ msisdn, locale }),
  });
}

export async function verifyTenantOtp(msisdn: string, code: string) {
  const res = await apiRequest<{ access: string; refresh: string; user: ApiUserProfile }>(
    '/api/v1/auth/tenant/otp/verify/',
    {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({ msisdn, code }),
    }
  );
  setStoredJwtTokens({ access: res.access, refresh: res.refresh });
  return res;
}

export async function loginStaffProduction(username: string, password: string, ownerCode: OwnerId) {
  const res = await apiRequest<{
    mfa_required: boolean;
    mfa_challenge_token?: string;
    access?: string;
    refresh?: string;
    user?: ApiUserProfile;
  }>('/api/v1/auth/staff/login/', {
    method: 'POST',
    skipAuth: true,
    body: JSON.stringify({ username, password, owner_code: ownerCode }),
  });
  if (!res.mfa_required && res.access && res.refresh) {
    setStoredJwtTokens({ access: res.access, refresh: res.refresh });
  }
  return res;
}

export async function verifyStaffMfa(mfaChallengeToken: string, totpCode: string) {
  const res = await apiRequest<{ access: string; refresh: string; user: ApiUserProfile }>(
    '/api/v1/auth/staff/mfa/verify/',
    {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({ mfa_challenge_token: mfaChallengeToken, totp_code: totpCode }),
    }
  );
  setStoredJwtTokens({ access: res.access, refresh: res.refresh });
  return res;
}

function hasHttpOrigin(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof fetch === 'function' &&
    Boolean(window.location?.origin?.startsWith('http'))
  );
}

export async function fetchVapidPublicKey(): Promise<string> {
  if (ENV_VAPID_PUBLIC_KEY) return ENV_VAPID_PUBLIC_KEY;
  if (API_BASE_URL) {
    try {
      const res = await apiRequest<{ publicKey: string }>('/api/v1/notifications/vapid-public-key/', {
        skipAuth: true,
      });
      return res.publicKey || '';
    } catch {
      return '';
    }
  }
  if (!hasHttpOrigin()) return '';
  try {
    const res = await fetch('/api/office/push/vapid-key', { cache: 'no-store' });
    if (!res.ok) return '';
    const data = (await res.json()) as { publicKey?: string };
    return data.publicKey || '';
  } catch {
    return '';
  }
}

export async function registerPushSubscriptionApi(payload: {
  endpoint: string;
  p256dh: string;
  auth: string;
  device_label: string;
  ownerId?: string;
  actorId?: string;
}) {
  if (API_BASE_URL) {
    return apiRequest<{ id: string }>('/api/v1/notifications/push-subscriptions/', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
  const res = await fetch('/api/office/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to register local push subscription.');
  return (await res.json()) as { id: string };
}

export async function unregisterPushSubscriptionApi(endpoint: string): Promise<void> {
  if (API_BASE_URL || !hasHttpOrigin()) return;
  try {
    await fetch('/api/office/push/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Ignore cleanup errors cleanly
  }
}

export async function sendOfficePushAlert(payload: {
  title: string;
  body: string;
  ownerId?: string;
  tag?: string;
}): Promise<{ attempted: number; delivered: number; failed: number }> {
  if (!hasHttpOrigin()) return { attempted: 0, delivered: 0, failed: 0 };
  const res = await fetch('/api/office/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to dispatch local VAPID push alert.');
  return (await res.json()) as { attempted: number; delivered: number; failed: number };
}

export async function requestOfficeTenantOtp(msisdn: string, locale: 'en' | 'am') {
  const res = await fetch('/api/office/auth/tenant/otp/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msisdn, locale }),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    detail?: string;
    sandboxOtpCode?: string;
    msisdn?: string;
    matchedAccount?: { username: string; tenantId: string; displayName: string; ownerId: string };
  };
  if (!res.ok) throw new Error(data.detail || 'Unable to generate sandbox OTP.');
  return data;
}

export async function verifyOfficeTenantOtp(msisdn: string, code: string) {
  const res = await fetch('/api/office/auth/tenant/otp/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msisdn, code }),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    detail?: string;
    msisdn?: string;
    account?: { username: string; tenantId: string; displayName: string; ownerId: string };
  };
  if (!res.ok || !data.account) {
    throw new Error(data.detail || 'Invalid sandbox OTP verification code.');
  }
  return data as {
    ok: true;
    msisdn: string;
    account: { username: string; tenantId: string; displayName: string; ownerId: string };
  };
}

export async function uploadOfficeEvidenceFile(params: {
  file: File;
  entityType: 'CBE_SLIP' | 'LEASE_PDF' | 'REPAIR_PHOTO' | 'TENANT_KYC' | 'ERCA_CERT';
  entityRefId?: string;
  ownerId?: string;
}): Promise<{
  fileId: string;
  objectKey: string;
  url: string;
  sha256: string;
}> {
  const res = await fetch('/api/office/uploads', {
    method: 'POST',
    headers: {
      'Content-Type': params.file.type,
      'X-File-Name': encodeURIComponent(params.file.name),
      'X-Entity-Type': params.entityType,
      'X-Entity-Ref-Id': params.entityRefId || '',
      'X-Owner-Id': params.ownerId || 'OWN-ALPHA',
    },
    body: params.file,
  });
  const data = (await res.json()) as {
    error?: boolean;
    msg?: string;
    fileId?: string;
    objectKey?: string;
    url?: string;
    sha256?: string;
  };
  if (!res.ok || data.error || !data.url || !data.objectKey) {
    throw new Error(data.msg || `Local evidence upload failed (${res.status}).`);
  }
  return {
    fileId: data.fileId || '',
    objectKey: data.objectKey,
    url: data.url,
    sha256: data.sha256 || '',
  };
}

export async function presignDocumentUpload(payload: {
  entity_type: 'CBE_SLIP' | 'LEASE_PDF' | 'REPAIR_PHOTO' | 'TENANT_KYC' | 'ERCA_CERT';
  filename: string;
  mime_type: string;
  file_size_bytes: number;
}) {
  return apiRequest<{ object_key: string; upload_url: string; expires_in_seconds: number }>(
    '/api/v1/documents/presign-upload/',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export async function confirmDocumentUpload(payload: {
  entity_type: 'CBE_SLIP' | 'LEASE_PDF' | 'REPAIR_PHOTO' | 'TENANT_KYC' | 'ERCA_CERT';
  entity_ref_id: string;
  object_key: string;
  filename: string;
  mime_type: string;
  file_size_bytes: number;
  sha256_checksum: string;
}) {
  return apiRequest<{ id: string; object_key: string }>('/api/v1/documents/confirm/', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchErcaGateStatus(ownerContext: OwnerId): Promise<ErcaGateStatus | null> {
  if (!API_BASE_URL) return null;
  try {
    return await apiRequest<ErcaGateStatus>('/api/v1/governance/erca-gate/', { ownerContext });
  } catch {
    return null;
  }
}
