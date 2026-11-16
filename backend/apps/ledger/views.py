from datetime import date
from decimal import Decimal
from django.core.exceptions import ValidationError
from django.db.models import Sum
from rest_framework import status, viewsets
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.response import Response
from rest_framework.views import APIView
from apps.common.permissions import DenyAuditorWrites, IsStaffUser, OwnerScopedMixin, bind_postgres_rls_owner, get_active_owner_code_for_request
from apps.portfolio.models import OwnerEntity
from .models import (
    AccountingPeriod,
    CloseChecklistItem,
    FixedAssetItem,
    GatewaySettlementBatch,
    JournalEntry,
    JournalLine,
    LedgerAccount,
    ReconciliationRun,
    TaxWorkpaper,
)
from .serializers import (
    AccountingPeriodSerializer,
    JournalEntrySerializer,
    LedgerAccountSerializer,
    ReconciliationRunSerializer,
    TaxWorkpaperSerializer,
)
from .services import evaluate_three_way_deposit_check, post_ledger_event, request_period_close, reverse_journal_entry
from .tax_engine import compute_workpaper_comparison


class LedgerAccountViewSet(OwnerScopedMixin, viewsets.ReadOnlyModelViewSet):
    queryset = LedgerAccount.objects.select_related('owner').order_by('code', '-version')
    serializer_class = LedgerAccountSerializer
    permission_classes = [IsStaffUser, DenyAuditorWrites]


class AccountingPeriodViewSet(OwnerScopedMixin, viewsets.ReadOnlyModelViewSet):
    queryset = AccountingPeriod.objects.select_related('owner').order_by('fiscal_year_ec', 'month_index')
    serializer_class = AccountingPeriodSerializer
    permission_classes = [IsStaffUser, DenyAuditorWrites]


class JournalEntryViewSet(OwnerScopedMixin, viewsets.ReadOnlyModelViewSet):
    queryset = JournalEntry.objects.select_related('owner', 'period').prefetch_related('lines__account').order_by('-entry_date', '-posted_at')
    serializer_class = JournalEntrySerializer
    permission_classes = [IsStaffUser, DenyAuditorWrites]


class TrialBalanceApiView(APIView):
    permission_classes = [IsStaffUser]

    def get(self, request):
        owner_code = get_active_owner_code_for_request(request.user, request)
        bind_postgres_rls_owner(owner_code)
        owner = OwnerEntity.objects.get(code=owner_code)
        period_code = request.query_params.get('period_code')

        line_qs = JournalLine.objects.filter(owner=owner).select_related('account', 'entry__period')
        if period_code:
            target_period = AccountingPeriod.objects.filter(owner=owner, period_code=period_code).first()
            if target_period:
                line_qs = line_qs.filter(
                    entry__period__fiscal_year_ec=target_period.fiscal_year_ec,
                    entry__period__month_index__lte=target_period.month_index,
                )

        rows = (
            line_qs.values('account__code', 'account__name', 'account__category', 'account__normal_balance')
            .annotate(total_debit=Sum('debit_etb'), total_credit=Sum('credit_etb'))
            .order_by('account__code')
        )

        accounts_out = []
        tb_dr = Decimal('0.00')
        tb_cr = Decimal('0.00')
        for row in rows:
            dr = row['total_debit'] or Decimal('0.00')
            cr = row['total_credit'] or Decimal('0.00')
            net_dr = dr - cr if dr >= cr else Decimal('0.00')
            net_cr = cr - dr if cr > dr else Decimal('0.00')
            tb_dr += net_dr
            tb_cr += net_cr
            accounts_out.append({
                'code': row['account__code'],
                'name': row['account__name'],
                'category': row['account__category'],
                'normal_balance': row['account__normal_balance'],
                'debit_etb': str(net_dr),
                'credit_etb': str(net_cr),
            })

        return Response({
            'owner_code': owner_code,
            'period_code': period_code,
            'total_debit_etb': str(tb_dr),
            'total_credit_etb': str(tb_cr),
            'balanced': tb_dr == tb_cr,
            'accounts': accounts_out,
        })


class PostJournalApiView(APIView):
    permission_classes = [IsStaffUser, DenyAuditorWrites]

    def post(self, request):
        owner_code = get_active_owner_code_for_request(request.user, request)
        bind_postgres_rls_owner(owner_code)
        owner = OwnerEntity.objects.get(code=owner_code)
        data = request.data

        try:
            entry = post_ledger_event(
                owner=owner,
                period_code=data['period_code'],
                entry_date=date.fromisoformat(data['entry_date']),
                rule_id=data['rule_id'],
                source_type=data.get('source_type', 'ManualJournal'),
                source_id=data.get('source_id', 'API'),
                idempotency_key=data['idempotency_key'],
                description=data.get('description', ''),
                lines=data.get('lines', []),
                maker_actor_id=str(getattr(request.user, 'id', 'API-ACTOR')),
                checker_actor_id=data.get('checker_actor_id', ''),
            )
        except (KeyError, ValueError, ValidationError) as exc:
            raise DRFValidationError({'detail': str(exc)}) from exc

        if entry is None:
            return Response({'posted': False, 'reason': 'PR-08 failed gateway event creates 0 accounting entries.'})
        return Response(JournalEntrySerializer(entry).data, status=status.HTTP_201_CREATED)


class ReverseJournalApiView(APIView):
    permission_classes = [IsStaffUser, DenyAuditorWrites]

    def post(self, request, journal_id):
        owner_code = get_active_owner_code_for_request(request.user, request)
        bind_postgres_rls_owner(owner_code)
        owner = OwnerEntity.objects.get(code=owner_code)
        original = JournalEntry.objects.get(id=journal_id, owner=owner)

        try:
            reversal = reverse_journal_entry(
                original_entry=original,
                period_code=request.data['period_code'],
                reversal_date=date.fromisoformat(request.data['reversal_date']),
                reason=request.data.get('reason', 'PR-25 authorized reversal'),
                maker_actor_id=request.data.get('maker_actor_id', original.maker_actor_id),
                checker_actor_id=str(getattr(request.user, 'id', '')),
            )
        except (KeyError, ValueError, ValidationError) as exc:
            raise DRFValidationError({'detail': str(exc)}) from exc

        return Response(JournalEntrySerializer(reversal).data, status=status.HTTP_201_CREATED)


class PeriodCloseApiView(APIView):
    permission_classes = [IsStaffUser, DenyAuditorWrites]

    def post(self, request):
        owner_code = get_active_owner_code_for_request(request.user, request)
        bind_postgres_rls_owner(owner_code)
        owner = OwnerEntity.objects.get(code=owner_code)

        try:
            period = request_period_close(
                owner=owner,
                period_code=request.data['period_code'],
                maker_actor_id=request.data['maker_actor_id'],
                checker_actor_id=str(getattr(request.user, 'id', '')),
            )
        except (KeyError, ValidationError) as exc:
            raise DRFValidationError({'detail': str(exc)}) from exc

        return Response(AccountingPeriodSerializer(period).data)


class ThreeWayDepositCheckApiView(APIView):
    permission_classes = [IsStaffUser]

    def get(self, request):
        owner_code = get_active_owner_code_for_request(request.user, request)
        bind_postgres_rls_owner(owner_code)
        owner = OwnerEntity.objects.get(code=owner_code)
        result = evaluate_three_way_deposit_check(owner=owner)
        return Response({
            'owner_code': owner_code,
            'lease_register_etb': str(result['lease_register_etb']),
            'gl_2120_etb': str(result['gl_2120_etb']),
            'subledger_etb': str(result['subledger_etb']),
            'passed': result['passed'],
        })


class TaxWorkpaperApiView(APIView):
    permission_classes = [IsStaffUser]

    def get(self, request):
        owner_code = get_active_owner_code_for_request(request.user, request)
        bind_postgres_rls_owner(owner_code)
        owner = OwnerEntity.objects.get(code=owner_code)
        workpapers = TaxWorkpaper.objects.filter(owner=owner).order_by('-generated_at')
        return Response(TaxWorkpaperSerializer(workpapers, many=True).data)

    def post(self, request):
        owner_code = get_active_owner_code_for_request(request.user, request)
        bind_postgres_rls_owner(owner_code)
        payload = request.data
        result = compute_workpaper_comparison(
            gross_rent_etb=Decimal(str(payload.get('gross_rent_etb', '0'))),
            operating_expenses_etb=Decimal(str(payload.get('operating_expenses_etb', '0'))),
            depreciation_etb=Decimal(str(payload.get('depreciation_etb', '0'))),
            entity_type=payload.get('entity_type', 'SoleProprietor'),
            vat_registered=bool(payload.get('vat_registered', False)),
            wht_qualifying_payments_etb=Decimal(str(payload.get('wht_qualifying_payments_etb', '0'))),
            property_assessed_value_etb=Decimal(str(payload.get('property_assessed_value_etb', '0'))),
            enable_live_tax_invoicing=False,
        )
        return Response(result)
