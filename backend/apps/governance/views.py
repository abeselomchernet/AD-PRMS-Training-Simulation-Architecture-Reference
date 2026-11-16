from django.core.exceptions import ValidationError
from django.utils import timezone
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView
from apps.common.permissions import (
    DenyAuditorWrites,
    IsStaffUser,
    OwnerScopedMixin,
    bind_postgres_rls_owner,
    get_active_owner_code_for_request,
)
from apps.realtime.publisher import broadcast_owner_event
from .models import ApprovalRequest, AuditEvent, BackupSnapshotRecord, ErcaVerificationGate, TaxRule


class ApprovalRequestSerializer(serializers.ModelSerializer):
    class Meta:
        model = ApprovalRequest
        fields = '__all__'


class TaxRuleSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaxRule
        fields = '__all__'

    def validate(self, attrs):
        instance = TaxRule(**{**({'owner': self.instance.owner} if self.instance else {}), **attrs})
        try:
            instance.clean()
        except ValidationError as exc:
            raise serializers.ValidationError({'lifecycle_stage': exc.messages})
        return attrs


class AuditEventSerializer(serializers.ModelSerializer):
    class Meta:
        model = AuditEvent
        fields = '__all__'


class BackupSnapshotSerializer(serializers.ModelSerializer):
    class Meta:
        model = BackupSnapshotRecord
        fields = '__all__'


class ApprovalRequestViewSet(OwnerScopedMixin, viewsets.ModelViewSet):
    queryset = ApprovalRequest.objects.select_related('owner').all()
    serializer_class = ApprovalRequestSerializer
    permission_classes = [IsStaffUser, DenyAuditorWrites]

    @action(detail=True, methods=['post'])
    def decide(self, request, pk=None):
        req = self.get_object()
        decision = str(request.data.get('decision', '')).strip()  # Approved | Rejected | Returned
        comment = str(request.data.get('comment', '')).strip()
        if decision not in ('Approved', 'Rejected', 'Returned') or not comment:
            return Response({'detail': 'Valid decision and mandatory comment are required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            req.assert_checker_sod(request.user.actor_id)
        except ValidationError as exc:
            return Response({'detail': exc.message}, status=status.HTTP_403_FORBIDDEN)

        req.status = decision
        req.finalized = decision in ('Approved', 'Rejected')
        req.decision_log.append({
            'timestamp': timezone.now().isoformat(),
            'actor_id': request.user.actor_id,
            'persona': request.user.role,
            'action': decision,
            'comment': comment,
        })
        req.save(update_fields=['status', 'finalized', 'decision_log'])

        AuditEvent.objects.create(
            owner=req.owner,
            actor_id=request.user.actor_id,
            persona=request.user.role,
            module='Approvals Centre',
            action=f'Approval {decision}',
            record_type='ApprovalRequest',
            record_id=req.request_number,
            reason=comment,
        )
        broadcast_owner_event(
            owner_code=req.owner.code,
            event_type='approval:decided',
            data={'request_number': req.request_number, 'status': req.status},
        )
        return Response(ApprovalRequestSerializer(req).data)


class ErcaGateStatusView(APIView):
    permission_classes = [IsStaffUser]

    def get(self, request):
        owner_code = get_active_owner_code_for_request(request.user, request)
        bind_postgres_rls_owner(owner_code)
        gate = ErcaVerificationGate.objects.filter(owner__code=owner_code).first()
        if not gate:
            return Response({
                'owner_code': owner_code,
                'erca_tin_verified': False,
                'vat_certificate_verified': False,
                'adviser_signed_off': False,
                'owner_activation_approved': False,
                'live_tax_enabled': False,
                'can_activate_tax_rules': False,
            })
        return Response({
            'owner_code': owner_code,
            'erca_tin_verified': gate.erca_tin_verified,
            'vat_certificate_verified': gate.vat_certificate_verified,
            'adviser_signed_off': gate.adviser_signed_off,
            'owner_activation_approved': gate.owner_activation_approved,
            'live_tax_enabled': gate.live_tax_enabled,
            'can_activate_tax_rules': gate.can_activate_tax_rules(),
        })


class TaxRuleViewSet(OwnerScopedMixin, viewsets.ModelViewSet):
    queryset = TaxRule.objects.select_related('owner').all()
    serializer_class = TaxRuleSerializer
    permission_classes = [IsStaffUser, DenyAuditorWrites]


class AuditEventViewSet(OwnerScopedMixin, viewsets.ReadOnlyModelViewSet):
    queryset = AuditEvent.objects.select_related('owner').order_by('-created_at')
    serializer_class = AuditEventSerializer
    permission_classes = [IsStaffUser]


class BackupSnapshotViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = BackupSnapshotRecord.objects.order_by('-created_at')
    serializer_class = BackupSnapshotSerializer
    permission_classes = [IsStaffUser, DenyAuditorWrites]
