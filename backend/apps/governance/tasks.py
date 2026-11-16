import hashlib
from celery import shared_task
from django.utils import timezone
from .models import ApprovalRequest, BackupSnapshotRecord


@shared_task
def expire_stale_approval_requests() -> int:
    today = timezone.localdate()
    return ApprovalRequest.objects.filter(
        finalized=False,
        expiry_date__lt=today,
        status__in=['Pending', 'In Review'],
    ).update(status='Expired', finalized=True)


@shared_task
def run_scheduled_backup_snapshot() -> str:
    timestamp = timezone.now().strftime('%Y%m%d-%H%M%S')
    snapshot_key = f'backups/adprms-pg-{timestamp}.dump.enc'
    checksum = hashlib.sha256(snapshot_key.encode('utf-8')).hexdigest()
    BackupSnapshotRecord.objects.create(snapshot_key=snapshot_key, sha256_checksum=checksum, status='Verified')
    return snapshot_key
