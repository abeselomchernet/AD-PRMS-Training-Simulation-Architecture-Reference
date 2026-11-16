from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from apps.common.permissions import DenyAuditorWrites, OwnerScopedMixin
from apps.realtime.publisher import broadcast_owner_event
from .models import MaintenanceMessage, MaintenanceTicket


class MaintenanceMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = MaintenanceMessage
        fields = '__all__'


class MaintenanceTicketSerializer(serializers.ModelSerializer):
    class Meta:
        model = MaintenanceTicket
        fields = '__all__'


class MaintenanceTicketViewSet(OwnerScopedMixin, viewsets.ModelViewSet):
    queryset = MaintenanceTicket.objects.select_related('owner', 'unit', 'tenant').all()
    serializer_class = MaintenanceTicketSerializer
    permission_classes = [DenyAuditorWrites]
    tenant_field = 'tenant_id'

    @action(detail=True, methods=['get', 'post'])
    def messages(self, request, pk=None):
        ticket = self.get_object()
        is_tenant = getattr(request.user, 'user_type', '') == 'TENANT'

        if request.method == 'GET':
            qs = ticket.messages.all()
            if is_tenant:
                qs = qs.filter(visibility=MaintenanceMessage.Visibility.SHARED_WITH_TENANT)
            return Response(MaintenanceMessageSerializer(qs, many=True).data)

        visibility = (
            MaintenanceMessage.Visibility.SHARED_WITH_TENANT
            if is_tenant
            else request.data.get('visibility', MaintenanceMessage.Visibility.SHARED_WITH_TENANT)
        )
        msg = MaintenanceMessage.objects.create(
            owner=ticket.owner,
            ticket=ticket,
            sender_actor_id=request.user.actor_id,
            sender_name=request.user.get_full_name() or request.user.username,
            sender_role='Tenant' if is_tenant else ('Owner' if request.user.role == 'Owner / Director' else 'Staff'),
            visibility=visibility,
            body=str(request.data.get('body', '')).strip(),
            attachment_key=str(request.data.get('attachment_key', '')),
        )

        # Only broadcast Shared messages to tenant channels; internal staff notes stay in staff/owner room
        broadcast_owner_event(
            owner_code=ticket.owner.code,
            event_type='maintenance:message',
            data=MaintenanceMessageSerializer(msg).data,
            tenant_id=str(ticket.tenant_id) if (ticket.tenant_id and visibility == MaintenanceMessage.Visibility.SHARED_WITH_TENANT) else None,
        )
        return Response(MaintenanceMessageSerializer(msg).data, status=status.HTTP_201_CREATED)
