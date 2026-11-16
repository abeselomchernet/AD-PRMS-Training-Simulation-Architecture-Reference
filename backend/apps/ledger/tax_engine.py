from decimal import Decimal, ROUND_HALF_UP
from typing import Any

TWO_DP = Decimal('0.01')


def _q2(val: Decimal | int | float | str) -> Decimal:
    return Decimal(str(val)).quantize(TWO_DP, rounding=ROUND_HALF_UP)


# Ethiopian Federal Income Tax Proclamation No. 1395/2025 Schedule B Annual Rental Income Bands
# Monthly / 12 scaled brackets: 200,000 ETB taxable income -> 45,400 ETB annual tax.
MARGINAL_BANDS_1395 = [
    (Decimal('24000.00'), Decimal('0.00'), Decimal('0.00')),
    (Decimal('48000.00'), Decimal('0.15'), Decimal('3600.00')),
    (Decimal('84000.00'), Decimal('0.20'), Decimal('6000.00')),
    (Decimal('120000.00'), Decimal('0.25'), Decimal('10200.00')),
    (Decimal('168000.00'), Decimal('0.30'), Decimal('16200.00')),
    (None, Decimal('0.35'), Decimal('24600.00')),
]


def compute_marginal_tax_1395(annual_taxable_etb: Decimal | int | float | str) -> Decimal:
    taxable = max(Decimal('0.00'), _q2(annual_taxable_etb))
    for upper, rate, deduction in MARGINAL_BANDS_1395:
        if upper is None or taxable <= upper:
            return max(Decimal('0.00'), _q2((taxable * rate) - deduction))
    return Decimal('0.00')


def compute_workpaper_comparison(
    *,
    gross_rent_etb: Decimal,
    operating_expenses_etb: Decimal,
    depreciation_etb: Decimal = Decimal('0.00'),
    entity_type: str = 'SoleProprietor',
    vat_registered: bool = False,
    wht_qualifying_payments_etb: Decimal = Decimal('0.00'),
    property_assessed_value_etb: Decimal = Decimal('0.00'),
    enable_live_tax_invoicing: bool = False,
) -> dict[str, Any]:
    """
    Computes dual Books-vs-Flat 20%/35% rental income tax comparison, VAT 15% draft,
    WHT 3% payable, 25% quarterly advance tax, and Property Tax Proclamation 1365/2025 (25% base).
    All figures remain non-fiscal workpapers while enable_live_tax_invoicing is False.
    """
    gross = max(Decimal('0.00'), _q2(gross_rent_etb))
    books_deductions = max(Decimal('0.00'), _q2(operating_expenses_etb + depreciation_etb))
    taxable_books = max(Decimal('0.00'), _q2(gross - books_deductions))

    # Flat statutory presumption: 20% expense allowance (post-1395 / transitional comparison) & legacy 35%
    taxable_flat_20 = _q2(gross * Decimal('0.80'))
    taxable_flat_35 = _q2(gross * Decimal('0.65'))

    if entity_type == 'PLC':
        tax_books = _q2(taxable_books * Decimal('0.30'))
        tax_flat_20 = _q2(taxable_flat_20 * Decimal('0.30'))
        tax_flat_35 = _q2(taxable_flat_35 * Decimal('0.30'))
    else:
        tax_books = compute_marginal_tax_1395(taxable_books)
        tax_flat_20 = compute_marginal_tax_1395(taxable_flat_20)
        tax_flat_35 = compute_marginal_tax_1395(taxable_flat_35)

    output_vat_draft = _q2(gross * Decimal('0.15')) if vat_registered else Decimal('0.00')
    wht_3pct = _q2(wht_qualifying_payments_etb * Decimal('0.03'))
    quarterly_advance_25pct = _q2(tax_books * Decimal('0.25'))

    # Proclamation 1365/2025 Property Tax: 25% taxable base of assessed property value, illustrative 0.5% levy
    property_tax_base = _q2(property_assessed_value_etb * Decimal('0.25'))
    property_tax_draft = _q2(property_tax_base * Decimal('0.005'))

    return {
        'proclamation_ref': '1395/2025 & 1365/2025',
        'fiscal_mode': 'LIVE_FISCAL' if enable_live_tax_invoicing else 'NON_FISCAL_DRAFT_ONLY',
        'enable_live_tax_invoicing': bool(enable_live_tax_invoicing),
        'entity_type': entity_type,
        'gross_rent_etb': gross,
        'books': {
            'deductions_etb': books_deductions,
            'taxable_income_etb': taxable_books,
            'estimated_tax_etb': tax_books,
        },
        'flat_20pct': {
            'deductions_etb': _q2(gross * Decimal('0.20')),
            'taxable_income_etb': taxable_flat_20,
            'estimated_tax_etb': tax_flat_20,
        },
        'flat_35pct': {
            'deductions_etb': _q2(gross * Decimal('0.35')),
            'taxable_income_etb': taxable_flat_35,
            'estimated_tax_etb': tax_flat_35,
        },
        'output_vat_15pct_draft_etb': output_vat_draft,
        'wht_3pct_payable_etb': wht_3pct,
        'quarterly_advance_25pct_etb': quarterly_advance_25pct,
        'property_tax_1365_base_etb': property_tax_base,
        'property_tax_1365_draft_etb': property_tax_draft,
    }
