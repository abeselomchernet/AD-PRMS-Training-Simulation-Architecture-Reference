from datetime import date
from decimal import Decimal
import uuid

from django.core.exceptions import ValidationError

from apps.ledger.tax_engine import compute_marginal_tax_1395, compute_workpaper_comparison


def test_proclamation_1395_marginal_tax_200k_reference():
    assert compute_marginal_tax_1395(Decimal('200000.00')) == Decimal('45400.00')
    assert compute_marginal_tax_1395(Decimal('24000.00')) == Decimal('0.00')


def test_workpaper_books_vs_flat_and_live_invoicing_guard():
    wp = compute_workpaper_comparison(
        gross_rent_etb=Decimal('990000.00'),
        operating_expenses_etb=Decimal('200880.00'),
        depreciation_etb=Decimal('264000.00'),
        entity_type='SoleProprietor',
        vat_registered=True,
        wht_qualifying_payments_etb=Decimal('12000.00'),
        property_assessed_value_etb=Decimal('6000000.00'),
        enable_live_tax_invoicing=False,
    )
    assert wp['enable_live_tax_invoicing'] is False
    assert wp['fiscal_mode'] == 'NON_FISCAL_DRAFT_ONLY'
    assert wp['books']['taxable_income_etb'] == Decimal('525120.00')
    assert wp['flat_20pct']['deductions_etb'] == Decimal('198000.00')
    assert wp['flat_35pct']['deductions_etb'] == Decimal('346500.00')
    assert wp['output_vat_15pct_draft_etb'] == Decimal('148500.00')
    assert wp['wht_3pct_payable_etb'] == Decimal('360.00')
    assert wp['quarterly_advance_25pct_etb'] == (wp['books']['estimated_tax_etb'] * Decimal('0.25')).quantize(Decimal('0.01'))
    assert wp['property_tax_1365_base_etb'] == Decimal('1500000.00')


def test_workpaper_plc_corporate_30_percent():
    wp = compute_workpaper_comparison(
        gross_rent_etb=Decimal('500000.00'),
        operating_expenses_etb=Decimal('100000.00'),
        entity_type='PLC',
        vat_registered=False,
        enable_live_tax_invoicing=False,
    )
    assert wp['books']['taxable_income_etb'] == Decimal('400000.00')
    assert wp['books']['estimated_tax_etb'] == Decimal('120000.00')


def test_pr08_failed_gateway_and_sod_reversal_guards(db=None):
    # Pure service-level unit check for PR-08 & Maker-Checker SoD without requiring live DB fixture when sqlite isn't migrated
    from apps.ledger.services import post_ledger_event, reverse_journal_entry
    from apps.ledger.models import JournalEntry
    from apps.portfolio.models import OwnerEntity

    dummy_owner = OwnerEntity(id=uuid.uuid4(), code='OWN-UNIT', name='Unit Owner', entity_type='Individual', effective_date=date(2026, 1, 1))
    res = post_ledger_event(
        owner=dummy_owner,
        period_code='2019-03',
        entry_date=date(2026, 11, 24),
        rule_id='PR-08',
        source_type='GatewayAttempt',
        source_id='E1',
        idempotency_key='UNIT-PR08-E1',
        description='Failed Telebirr E1',
        lines=[],
        maker_actor_id='ACT-COL-01',
    )
    assert res is None

    dummy_entry = JournalEntry(id=uuid.uuid4(), owner=dummy_owner, journal_number='J15', maker_actor_id='ACT-FIN-01')
    try:
        reverse_journal_entry(
            original_entry=dummy_entry,
            period_code='2019-03',
            reversal_date=date(2026, 11, 25),
            reason='Self reversal check',
            maker_actor_id='ACT-FIN-01',
            checker_actor_id='ACT-FIN-01',
        )
        assert False, 'Expected ValidationError for Maker-Checker SoD violation'
    except ValidationError:
        pass
