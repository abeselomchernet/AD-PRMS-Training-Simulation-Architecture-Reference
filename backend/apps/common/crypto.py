import base64
import hashlib
import re
from cryptography.fernet import Fernet
from django.conf import settings

ETHIOPIAN_MSISDN_RE = re.compile(r'^\+251(9|7)\d{8}$')


def normalize_ethiopian_msisdn(raw: str) -> str:
    cleaned = re.sub(r'[\s\-()]', '', (raw or '').strip())
    if cleaned.startswith('09') or cleaned.startswith('07'):
        cleaned = f'+251{cleaned[1:]}'
    elif cleaned.startswith('2519') or cleaned.startswith('2517'):
        cleaned = f'+{cleaned}'
    elif len(cleaned) == 9 and (cleaned.startswith('9') or cleaned.startswith('7')):
        cleaned = f'+251{cleaned}'
    if not ETHIOPIAN_MSISDN_RE.match(cleaned):
        raise ValueError('Must be a valid Ethiopian mobile number (+2519xxxxxxxx or +2517xxxxxxxx).')
    return cleaned


def _get_fernet() -> Fernet:
    configured = getattr(settings, 'FIELD_ENCRYPTION_KEY', '') or ''
    if configured:
        return Fernet(configured.encode('utf-8'))
    digest = hashlib.sha256(settings.SECRET_KEY.encode('utf-8')).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str) -> str:
    if not value:
        return ''
    return _get_fernet().encrypt(value.encode('utf-8')).decode('utf-8')


def decrypt_secret(token: str) -> str:
    if not token:
        return ''
    return _get_fernet().decrypt(token.encode('utf-8')).decode('utf-8')
