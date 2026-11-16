import uuid
from django.db import models


class OwnerEntity(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=32, unique=True, db_index=True)
    name = models.CharField(max_length=255)
    entity_type = models.CharField(max_length=64)
    status = models.CharField(max_length=32, default='Active')
    tin_encrypted = models.TextField(blank=True)
    vat_reg_encrypted = models.TextField(blank=True)
    address = models.TextField(blank=True)
    contact_phone = models.CharField(max_length=32, blank=True)
    contact_email = models.EmailField(blank=True)
    version = models.PositiveIntegerField(default=1)
    effective_date = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)


class Property(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(OwnerEntity, on_delete=models.PROTECT, related_name='properties')
    code = models.CharField(max_length=32)
    name = models.CharField(max_length=255)
    sub_city = models.CharField(max_length=120)
    woreda = models.CharField(max_length=64)
    street = models.CharField(max_length=255, blank=True)
    landmark = models.CharField(max_length=255, blank=True)
    property_type = models.CharField(max_length=64)
    status = models.CharField(max_length=32, default='Active')
    effective_date = models.DateField()

    class Meta:
        unique_together = ('owner', 'code')


class Building(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(OwnerEntity, on_delete=models.PROTECT, related_name='buildings')
    property_ref = models.ForeignKey(Property, on_delete=models.PROTECT, related_name='buildings')
    code = models.CharField(max_length=32)
    name = models.CharField(max_length=255)
    floors = models.PositiveSmallIntegerField(default=1)
    status = models.CharField(max_length=32, default='Active')


class Unit(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(OwnerEntity, on_delete=models.PROTECT, related_name='units')
    property_ref = models.ForeignKey(Property, on_delete=models.PROTECT, related_name='units')
    building = models.ForeignKey(Building, on_delete=models.PROTECT, related_name='units')
    code = models.CharField(max_length=32)
    name = models.CharField(max_length=255)
    floor = models.IntegerField(default=0)
    area_sqm = models.DecimalField(max_digits=10, decimal_places=2)
    unit_type = models.CharField(max_length=64)
    status = models.CharField(max_length=32, default='Vacant')
    base_rent_etb = models.DecimalField(max_digits=14, decimal_places=2)
    previous_identifiers = models.JSONField(default=list)


class TenantProfile(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(OwnerEntity, on_delete=models.PROTECT, related_name='tenants')
    code = models.CharField(max_length=32)
    name = models.CharField(max_length=255)
    business_type = models.CharField(max_length=120)
    phone_msisdn = models.CharField(max_length=20, db_index=True)
    email = models.EmailField(blank=True)
    emergency_contact = models.CharField(max_length=255, blank=True)
    id_number_encrypted = models.TextField(blank=True)
    status = models.CharField(max_length=32, default='Active')


class Lease(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(OwnerEntity, on_delete=models.PROTECT, related_name='leases')
    lease_number = models.CharField(max_length=64)
    version = models.PositiveIntegerField(default=1)
    supersedes_lease = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL)
    unit = models.ForeignKey(Unit, on_delete=models.PROTECT, related_name='leases')
    tenant = models.ForeignKey(TenantProfile, on_delete=models.PROTECT, related_name='leases')
    status = models.CharField(max_length=32, default='Draft')
    start_date = models.DateField()
    end_date = models.DateField()
    monthly_rent_etb = models.DecimalField(max_digits=14, decimal_places=2)
    security_deposit_etb = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    billing_cycle = models.CharField(max_length=16, default='Monthly')
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
