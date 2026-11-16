from rest_framework import serializers, viewsets
from apps.common.permissions import DenyAuditorWrites, OwnerScopedMixin
from .models import Charge, PaymentReceipt


class ChargeSerializer(serializers.ModelSerializer):
    class Meta:
        model = Charge
        fields = '__all__'


class PaymentReceiptSerializer(serializers.ModelSerializer):
    class Meta:
        model = PaymentReceipt
        fields = '__all__'


class ChargeViewSet(OwnerScopedMixin, viewsets.ReadOnlyModelViewSet):
    queryset = Charge.objects.select_related('owner', 'tenant', 'unit', 'lease').all()
    serializer_class = ChargeSerializer
    permission_classes = [DenyAuditorWrites]
    tenant_field = 'tenant_id'


class PaymentReceiptViewSet(OwnerScopedMixin, viewsets.ReadOnlyModelViewSet):
    queryset = PaymentReceipt.objects.select_related('owner', 'tenant', 'unit').all()
    serializer_class = PaymentReceiptSerializer
    permission_classes = [DenyAuditorWrites]
    tenant_field = 'tenant_id'
