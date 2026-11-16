import uuid
from django.db import transaction
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView
from apps.common.permissions import (
    DenyAuditorWrites,
    bind_postgres_rls_owner,
    get_active_owner_code_for_request,
)
from apps.portfolio.models import OwnerEntity
from .models import DocumentAsset
from .storage import (
    generate_presigned_download_url,
    generate_presigned_upload_url,
    sanitize_uploaded_document_async,
)

ALLOWED_MIMES = {'image/jpeg', 'image/png', 'image/webp', 'application/pdf'}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB


class PresignUploadView(APIView):
    permission_classes = [DenyAuditorWrites]

    def post(self, request):
        mime_type = str(request.data.get('mime_type', '')).lower()
        size_bytes = int(request.data.get('file_size_bytes', 0))
        entity_type = str(request.data.get('entity_type', DocumentAsset.EntityType.CBE_SLIP))
        filename = str(request.data.get('filename', 'evidence.bin')).replace('/', '_')

        if entity_type not in DocumentAsset.EntityType.values:
            return Response({'detail': 'Invalid entity_type.'}, status=status.HTTP_400_BAD_REQUEST)
        if mime_type not in ALLOWED_MIMES:
            return Response({'detail': 'Unsupported file type. Allowed: JPEG, PNG, WEBP, PDF.'}, status=status.HTTP_400_BAD_REQUEST)
        if size_bytes <= 0 or size_bytes > MAX_UPLOAD_BYTES:
            return Response({'detail': 'File must be between 1 byte and 10 MB.'}, status=status.HTTP_400_BAD_REQUEST)

        owner_code = get_active_owner_code_for_request(request.user, request)
        object_key = f'{owner_code}/{entity_type.lower()}/{uuid.uuid4().hex}-{filename}'
        upload_url = generate_presigned_upload_url(object_key=object_key, mime_type=mime_type)
        return Response({'object_key': object_key, 'upload_url': upload_url, 'expires_in_seconds': 300})


class ConfirmUploadView(APIView):
    permission_classes = [DenyAuditorWrites]

    @transaction.atomic
    def post(self, request):
        owner_code = get_active_owner_code_for_request(request.user, request)
        bind_postgres_rls_owner(owner_code)

        object_key = str(request.data.get('object_key', ''))
        if not object_key.startswith(f'{owner_code}/'):
            return Response({'detail': 'Object key does not match active owner scope.'}, status=status.HTTP_403_FORBIDDEN)

        owner = OwnerEntity.objects.filter(code=owner_code).first()
        if not owner:
            return Response({'detail': 'Owner entity not found.'}, status=status.HTTP_404_NOT_FOUND)

        doc = DocumentAsset.objects.create(
            owner=owner,
            entity_type=request.data['entity_type'],
            entity_ref_id=str(request.data.get('entity_ref_id', '')),
            object_key=object_key,
            original_filename=request.data['filename'],
            mime_type=request.data['mime_type'],
            file_size_bytes=int(request.data['file_size_bytes']),
            sha256_checksum=str(request.data.get('sha256_checksum', '')),
            uploaded_by_actor_id=request.user.actor_id,
        )
        sanitize_uploaded_document_async.delay(str(doc.id))
        return Response({'id': str(doc.id), 'object_key': doc.object_key}, status=status.HTTP_201_CREATED)


class SignedDownloadView(APIView):
    @transaction.atomic
    def get(self, request, pk):
        owner_code = get_active_owner_code_for_request(request.user, request)
        bind_postgres_rls_owner(owner_code)

        doc = DocumentAsset.objects.select_related('owner').filter(id=pk).first()
        if not doc:
            return Response({'detail': 'Document not found.'}, status=status.HTTP_404_NOT_FOUND)

        allowed = list(getattr(request.user, 'allowed_owners', []) or [request.user.owner_code])
        if doc.owner.code != owner_code or doc.owner.code not in allowed:
            return Response({'detail': 'Forbidden cross-owner document access.'}, status=status.HTTP_403_FORBIDDEN)

        if getattr(request.user, 'user_type', '') == 'TENANT':
            tenant_ref = str(getattr(request.user, 'tenant_id_ref', '') or '')
            if doc.uploaded_by_actor_id != request.user.actor_id and doc.entity_ref_id != tenant_ref:
                return Response({'detail': 'Forbidden cross-tenant document access.'}, status=status.HTTP_403_FORBIDDEN)

        return Response({'download_url': generate_presigned_download_url(object_key=doc.object_key)})
