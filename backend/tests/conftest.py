import os
import pytest


@pytest.fixture(scope='session')
def django_db_setup(request):
    """
    When CI runs against a pre-created, pre-migrated, role-hardened PostgreSQL 16 test database
    as restricted role `adprms_app` (NOCREATEDB, NOBYPASSRLS), skip CREATE DATABASE and reuse the
    configured DATABASE_URL directly.
    """
    if os.environ.get('DJANGO_USE_PREMIGRATED_TEST_DB', '').lower() == 'true':
        yield
        return

    from pytest_django.fixtures import django_db_setup as default_django_db_setup

    yield from default_django_db_setup.__wrapped__(request)
