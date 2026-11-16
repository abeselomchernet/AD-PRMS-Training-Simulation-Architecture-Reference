from rest_framework import serializers
from .models import (
    AccountingPeriod,
    CloseChecklistItem,
    FixedAssetItem,
    GatewaySettlementBatch,
    JournalEntry,
    JournalLine,
    Ledger,
    LedgerAccount,
    PostingRuleVersion,
    ReconciliationRun,
    TaxRulePack,
    TaxWorkpaper,
)


class LedgerSerializer(serializers.ModelSerializer):
    class Meta:
        model = Ledger
        fields = '__all__'


class LedgerAccountSerializer(serializers.ModelSerializer):
    class Meta:
        model = LedgerAccount
        fields = '__all__'


class AccountingPeriodSerializer(serializers.ModelSerializer):
    class Meta:
        model = AccountingPeriod
        fields = '__all__'


class PostingRuleVersionSerializer(serializers.ModelSerializer):
    class Meta:
        model = PostingRuleVersion
        fields = '__all__'


class JournalLineSerializer(serializers.ModelSerializer):
    account_code = serializers.CharField(source='account.code', read_only=True)
    account_name = serializers.CharField(source='account.name', read_only=True)

    class Meta:
        model = JournalLine
        fields = '__all__'


class JournalEntrySerializer(serializers.ModelSerializer):
    lines = JournalLineSerializer(many=True, read_only=True)
    period_code = serializers.CharField(source='period.period_code', read_only=True)

    class Meta:
        model = JournalEntry
        fields = '__all__'


class GatewaySettlementBatchSerializer(serializers.ModelSerializer):
    class Meta:
        model = GatewaySettlementBatch
        fields = '__all__'


class ReconciliationRunSerializer(serializers.ModelSerializer):
    class Meta:
        model = ReconciliationRun
        fields = '__all__'


class CloseChecklistItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = CloseChecklistItem
        fields = '__all__'


class FixedAssetItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = FixedAssetItem
        fields = '__all__'


class TaxRulePackSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaxRulePack
        fields = '__all__'


class TaxWorkpaperSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaxWorkpaper
        fields = '__all__'
