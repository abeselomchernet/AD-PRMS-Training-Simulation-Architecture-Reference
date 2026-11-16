from rest_framework import serializers
from .models import Building, Lease, OwnerEntity, Property, TenantProfile, Unit


class OwnerEntitySerializer(serializers.ModelSerializer):
    class Meta:
        model = OwnerEntity
        fields = ('id', 'code', 'name', 'entity_type', 'status', 'address', 'contact_phone', 'contact_email', 'version', 'effective_date')


class UnitSerializer(serializers.ModelSerializer):
    class Meta:
        model = Unit
        fields = '__all__'


class TenantProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = TenantProfile
        fields = ('id', 'owner', 'code', 'name', 'business_type', 'phone_msisdn', 'email', 'emergency_contact', 'status')


class LeaseSerializer(serializers.ModelSerializer):
    class Meta:
        model = Lease
        fields = '__all__'


class PropertySerializer(serializers.ModelSerializer):
    class Meta:
        model = Property
        fields = '__all__'


class BuildingSerializer(serializers.ModelSerializer):
    class Meta:
        model = Building
        fields = '__all__'
