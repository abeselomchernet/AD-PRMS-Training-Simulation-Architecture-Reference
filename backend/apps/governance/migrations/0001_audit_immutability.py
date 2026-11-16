from django.db import migrations


class Migration(migrations.Migration):
    dependencies = []

    operations = [
        migrations.RunSQL(
            sql="""
            CREATE OR REPLACE FUNCTION prevent_audit_mutation()
            RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'AuditEvent rows are immutable (append-only)';
            END;
            $$ LANGUAGE plpgsql;
            """,
            reverse_sql="DROP FUNCTION IF EXISTS prevent_audit_mutation();",
        ),
    ]
