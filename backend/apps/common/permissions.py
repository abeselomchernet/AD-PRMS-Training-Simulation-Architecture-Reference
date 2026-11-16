from django.db import connection, transaction
from rest_framework import permissions
from rest_framework.exceptions import PermissionDenied


def get_active_owner_code_for_request(user, request) -> str:
    requested = request.headers.get('X-Owner-Context') or request.query_params.get('owner_id')
    allowed = list(getattr(user, 'allowed_owners', []) or [])
    if getattr(user, 'user_type', '') == 'TENANT':
        if not getattr(user, 'owner_code', ''):
            raise PermissionDenied('Tenant account is missing owner binding.')
        return user.owner_code
    if getattr(user, 'role', '') == 'Owner / Director':
        target = allowed[0] if allowed else (getattr(user, 'owner_code', '') or 'OWN-ALPHA')
        if requested and requested != target:
            raise PermissionDenied('Owner / Director is locked to a single authorized owner entity.')
        return target
    if requested:
        if requested not in allowed:
            raise PermissionDenied('Cross-owner context access is prohibited.')
        return requested
    return allowed[0] if allowed else (getattr(user, 'owner_code', '') or 'OWN-ALPHA')


def bind_postgres_rls_owner(owner_code: str) -> None:
    """
    Binds transaction-local PostgreSQL RLS context (`SET LOCAL app.current_owner_id`)
    whenever running on PostgreSQL inside an active transaction. Safely no-ops on SQLite.
    """
    if connection.vendor != 'postgresql' or not owner_code:
        return
    if not connection.in_atomic_block:
        return
    from apps.portfolio.models import OwnerEntity

    owner_id = OwnerEntity.objects.filter(code=owner_code).values_list('id', flat=True).first()
    if owner_id:
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_config('app.current_owner_id', %s, true)", [str(owner_id)])


class DenyAuditorWrites(permissions.BasePermission):
    """Auditor / Read-only reviewer can inspect permitted owner records but never mutate state."""

    def has_permission(self, request, view) -> bool:
        user = request.user
        if not user or not user.is_authenticated:
            return False
        if getattr(user, 'role', '') == 'Auditor / Read-only reviewer' and request.method not in permissions.SAFE_METHODS:
            return False
        return True


class IsStaffUser(permissions.BasePermission):
    def has_permission(self, request, view) -> bool:
        user = request.user
        return bool(user and user.is_authenticated and getattr(user, 'user_type', '') == 'STAFF')


class OwnerScopedMixin:
    """
    Enforces strict Owner Isolation at both the ORM queryset layer and PostgreSQL RLS layer.
    Tenants see only their own tenant_id + owner_id; Staff see only owners in allowed_owners;
    Owner / Director is locked to a single authorized owner_id.
    """

    owner_field = 'owner__code'
    tenant_field = None

    def dispatch(self, request, *args, **kwargs):
        if connection.vendor == 'postgresql':
            with transaction.atomic():
                return super().dispatch(request, *args, **kwargs)
        return super().dispatch(request, *args, **kwargs)

    def get_active_owner_code(self) -> str:
        owner_code = get_active_owner_code_for_request(self.request.user, self.request)
        bind_postgres_rls_owner(owner_code)
        return owner_code

    def get_queryset(self):
        qs = super().get_queryset()
        user = self.request.user
        owner_code = self.get_active_owner_code()
        qs = qs.filter(**{self.owner_field: owner_code})
        if getattr(user, 'user_type', '') == 'TENANT' and self.tenant_field:
            if not getattr(user, 'tenant_id_ref', None):
                raise PermissionDenied('Tenant profile binding missing.')
            qs = qs.filter(**{self.tenant_field: user.tenant_id_ref})
        return qs
