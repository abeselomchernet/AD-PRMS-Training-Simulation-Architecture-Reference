from rest_framework import viewsets
from apps.common.permissions import DenyAuditorWrites, IsStaffUser, OwnerScopedMixin
from .models import Building, Lease, OwnerEntity, Property, TenantProfile, Unit
from .serializers import (
    BuildingSerializer,
    LeaseSerializer,
    OwnerEntitySerializer,
    PropertySerializer,
    TenantProfileSerializer,
    UnitSerializer,
)


class PropertyViewSet(OwnerScopedMixin, viewsets.ModelViewSet):
    queryset = Property.objects.select_related('owner').all()
    serializer_class = PropertySerializer
    permission_classes = [IsStaffUser, DenyAuditorWrites]


class BuildingViewSet(OwnerScopedMixin, viewsets.ModelViewSet):
    queryset = Building.objects.select_related('owner', 'property_ref').all()
    serializer_class = BuildingSerializer
    permission_classes = [IsStaffUser, DenyAuditorWrites]


class UnitViewSet(OwnerScopedMixin, viewsets.ModelViewSet):
    queryset = Unit.objects.select_related('owner', 'property_ref', 'building').all()
    serializer_class = UnitSerializer
    permission_classes = [DenyAuditorWrites]

    def get_queryset(self):
        qs = super().get_queryset()
        if getattr(self.request.user, 'user_type', '') == 'TENANT':
            return qs.filter(leases__tenant_id=self.request.user.tenant_id_ref).distinct()
        return qs


class TenantProfileViewSet(OwnerScopedMixin, viewsets.ModelViewSet):
    queryset = TenantProfile.objects.select_related('owner').all()
    serializer_class = TenantProfileSerializer
    permission_classes = [DenyAuditorWrites]
    tenant_field = 'id'


class LeaseViewSet(OwnerScopedMixin, viewsets.ModelViewSet):
    queryset = Lease.objects.select_related('owner', 'unit', 'tenant').all()
    serializer_class = LeaseSerializer
    permission_classes = [DenyAuditorWrites]
    tenant_field = 'tenant_id'


class OwnerViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = OwnerEntity.objects.all()
    serializer_class = OwnerEntitySerializer

    def get_queryset(self):
        allowed = list(getattr(self.request.user, 'allowed_owners', []) or [])
        return self.queryset.filter(code__in=allowed)
