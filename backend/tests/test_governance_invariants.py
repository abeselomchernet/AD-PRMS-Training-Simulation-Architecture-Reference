import hashlib
import hmac
import json
import logging

from apps.common.crypto import normalize_ethiopian_msisdn
from apps.common.logging import PiiMaskingFilter


def test_msisdn_normalization():
    assert normalize_ethiopian_msisdn('0911234567') == '+251911234567'
    assert normalize_ethiopian_msisdn('251712345678') == '+251712345678'
    assert normalize_ethiopian_msisdn('+251 911-234-567') == '+251911234567'


def test_arifpay_hmac_vector():
    secret = 'unit-test-secret'
    payload = json.dumps({'nonce': 'N-100', 'status': 'COMPLETED'}).encode('utf-8')
    sig = hmac.new(secret.encode('utf-8'), payload, hashlib.sha256).hexdigest()
    assert len(sig) == 64


def test_pii_masking_filter_redacts_msisdn_bearer_and_otp():
    filt = PiiMaskingFilter()
    record = logging.LogRecord(
        name='adprms.test',
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='Tenant +251911234567 logged in with Bearer abc.def.ghi and otp=482910',
        args=(),
        exc_info=None,
    )
    assert filt.filter(record) is True
    assert '+251911****67' in record.msg
    assert 'Bearer [REDACTED]' in record.msg
    assert 'otp=[REDACTED]' in record.msg
    assert 'abc.def.ghi' not in record.msg
    assert '482910' not in record.msg


def test_maker_checker_model_blocks_self_approval():
    from django.core.exceptions import ValidationError
    from apps.governance.models import ApprovalRequest

    req = ApprovalRequest(
        request_number='REQ-UNIT-001',
        category='Finance',
        title='Void Receipt',
        target_record_type='PaymentReceipt',
        target_record_id='RCT-001',
        maker_actor_id='ACT-FIN-01',
        maker_role='Finance Officer',
    )
    try:
        req.assert_checker_sod('ACT-FIN-01')
        assert False, 'Expected ValidationError on self-approval'
    except ValidationError:
        pass

    # Independent checker passes
    req.assert_checker_sod('ACT-GM-01')


def test_erca_gate_blocks_active_tax_rule_without_four_signoffs():
    from apps.governance.models import ErcaVerificationGate

    gate = ErcaVerificationGate(
        erca_tin_verified=True,
        vat_certificate_verified=True,
        adviser_signed_off=True,
        owner_activation_approved=False,
    )
    assert gate.can_activate_tax_rules() is False

    gate.owner_activation_approved = True
    assert gate.can_activate_tax_rules() is True
