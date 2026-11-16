from django.urls import include, path
from rest_framework.routers import DefaultRouter
from .views import BuildingViewSet, LeaseViewSet, OwnerViewSet, PropertyViewSet, TenantProfileViewSet, UnitViewSet

router = DefaultRouter()
router.register('owners', OwnerViewSet, basename='owners')
router.register('properties', PropertyViewSet, basename='properties')
router.register('buildings', BuildingViewSet, basename='buildings')
router.register('units', UnitViewSet, basename='units')
router.register('tenants', TenantProfileViewSet, basename='tenants')
router.register('leases', LeaseViewSet, basename='leases')

urlpatterns = [
    path('', include(router.urls)),
]
