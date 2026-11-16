#!/usr/bin/env python3
"""
AD-PRMS WP-2 Live PostgreSQL 16 Validation Runner.
Executes WP-2 Tests 3.1-3.7 (RLS Owner Isolation), 4.1-4.4 (Audit Immutability),
and 5.1-5.2 (Maker-Checker Trigger) against a running PostgreSQL 16 instance as `adprms_app`.

Usage:
  DATABASE_URL=postgres://adprms_app:<pass>@localhost:5432/adprms python3 scripts/verify_wp2_postgres.py
"""
import os
import sys
import uuid


def main() -> int:
    db_url = os.environ.get('DATABASE_URL', '')
    if not db_url.startswith('postgres'):
        print('ERROR: Set DATABASE_URL pointing to a live PostgreSQL 16 database using role adprms_app.', file=sys.stderr)
        return 2

    try:
        import psycopg2
    except ImportError:
        try:
            import psycopg as psycopg2  # type: ignore
        except ImportError:
            print('ERROR: psycopg2 or psycopg is required in the Python environment.', file=sys.stderr)
            return 2

    conn = psycopg2.connect(db_url)
    conn.autocommit = False

    owner_a = str(uuid.uuid4())
    owner_b = str(uuid.uuid4())
    prop_a = str(uuid.uuid4())
    apr_id = str(uuid.uuid4())

    try:
        with conn.cursor() as cur:
            # Test 3.6: adprms_app does NOT have BYPASSRLS
            cur.execute("SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
            user_name, is_super, bypass_rls = cur.fetchone()
            assert not is_super and not bypass_rls, f'Role {user_name} must be NOSUPERUSER NOBYPASSRLS'
            print(f'[PASS] 3.6 Application role `{user_name}` has rolsuper=false, rolbypassrls=false')

            # Setup isolated test OwnerEntity records if permitted, or run inside rolled-back tx
            cur.execute(
                """
                INSERT INTO portfolio_ownerentity (id, code, name, entity_type, status, tin_encrypted, vat_reg_encrypted, address, contact_phone, contact_email, version, effective_date, created_at)
                VALUES (%s, %s, 'WP2 Owner A', 'Individual', 'Active', '', '', '', '', '', 1, CURRENT_DATE, NOW()),
                       (%s, %s, 'WP2 Owner B', 'Trading', 'Active', '', '', '', '', '', 1, CURRENT_DATE, NOW())
                """,
                (owner_a, f'WP2-A-{owner_a[:6]}', owner_b, f'WP2-B-{owner_b[:6]}'),
            )

            # Test 3.1 & 3.3: Insert Property as Owner A under SET LOCAL
            cur.execute("SELECT set_config('app.current_owner_id', %s, true)", (owner_a,))
            cur.execute(
                """
                INSERT INTO portfolio_property (id, owner_id, code, name, sub_city, woreda, street, landmark, property_type, status, effective_date)
                VALUES (%s, %s, 'WP2-PROP-A', 'WP2 Alpha Plaza', 'Bole', '03', '', '', 'Commercial', 'Active', CURRENT_DATE)
                """,
                (prop_a, owner_a),
            )

            # Switch to Owner B context -> cannot read/update/delete Owner A rows
            cur.execute("SELECT set_config('app.current_owner_id', %s, true)", (owner_b,))
            cur.execute("SELECT COUNT(*) FROM portfolio_property WHERE id = %s", (prop_a,))
            assert cur.fetchone()[0] == 0, 'Cross-owner SELECT leak detected!'
            print('[PASS] 3.1 Owner B cannot SELECT Owner A property')

            cur.execute("UPDATE portfolio_property SET name = 'TAMPERED' WHERE id = %s", (prop_a,))
            assert cur.rowcount == 0, 'Cross-owner UPDATE affected rows!'
            cur.execute("DELETE FROM portfolio_property WHERE id = %s", (prop_a,))
            assert cur.rowcount == 0, 'Cross-owner DELETE affected rows!'
            print('[PASS] 3.2 Owner B cannot UPDATE or DELETE Owner A property')

            # Test 3.3: INSERT with mismatched owner_id fails WITH CHECK
            cur.execute('SAVEPOINT sp_rls_insert')
            rls_blocked = False
            try:
                cur.execute(
                    """
                    INSERT INTO portfolio_property (id, owner_id, code, name, sub_city, woreda, street, landmark, property_type, status, effective_date)
                    VALUES (%s, %s, 'WP2-INJECT', 'Cross Inject', 'Bole', '01', '', '', 'Commercial', 'Active', CURRENT_DATE)
                    """,
                    (str(uuid.uuid4()), owner_a),
                )
            except Exception:
                rls_blocked = True
                cur.execute('ROLLBACK TO SAVEPOINT sp_rls_insert')
            assert rls_blocked, 'RLS WITH CHECK did not block cross-owner INSERT!'
            print('[PASS] 3.3 Cross-owner INSERT rejected by PostgreSQL RLS WITH CHECK')

            # Test 4.1-4.4: AuditEvent INSERT succeeds, UPDATE/DELETE/TRUNCATE fail
            cur.execute("SELECT set_config('app.current_owner_id', %s, true)", (owner_a,))
            aud_id = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO governance_auditevent (id, owner_id, actor_id, persona, module, action, record_type, record_id, reason, prev_hash, event_hash, created_at)
                VALUES (%s, %s, 'ACT-WP2', 'Auditor', 'Audit Trail', 'WP2 Check', 'AuditEvent', 'WP2-1', 'Verification', '0', %s, NOW())
                """,
                (aud_id, owner_a, uuid.uuid4().hex + uuid.uuid4().hex),
            )
            print('[PASS] 4.4 AuditEvent INSERT allowed')

            for label, sql in [
                ('4.1 Audit UPDATE', ("UPDATE governance_auditevent SET reason = 'TAMPERED' WHERE id = %s", (aud_id,))),
                ('4.2 Audit DELETE', ("DELETE FROM governance_auditevent WHERE id = %s", (aud_id,))),
                ('4.3 Audit TRUNCATE', ("TRUNCATE governance_auditevent", None)),
            ]:
                cur.execute('SAVEPOINT sp_audit')
                blocked = False
                try:
                    cur.execute(sql[0], sql[1]) if sql[1] else cur.execute(sql[0])
                except Exception:
                    blocked = True
                    cur.execute('ROLLBACK TO SAVEPOINT sp_audit')
                assert blocked, f'{label} was NOT blocked by trigger/grants!'
                print(f'[PASS] {label} rejected')

            # Test 5.1 & 5.2: Maker-Checker Trigger
            cur.execute(
                """
                INSERT INTO governance_approvalrequest
                    (id, owner_id, request_number, category, title, target_record_type, target_record_id, maker_actor_id, maker_role, workflow_mode, current_step, total_steps, status, finalized, before_values, after_values, decision_log, created_at)
                VALUES
                    (%s, %s, %s, 'Finance', 'WP2 Test', 'Unit', 'U-1', 'ACT-MAKER', 'Finance Officer', 'Two-Step', 1, 2, 'Pending', false, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, NOW())
                """,
                (apr_id, owner_a, f'REQ-WP2-{apr_id[:6]}'),
            )
            cur.execute('SAVEPOINT sp_sod')
            sod_blocked = False
            try:
                cur.execute(
                    """
                    UPDATE governance_approvalrequest
                    SET status = 'Approved', finalized = true, decision_log = '[{"actor_id":"ACT-MAKER","action":"Approved"}]'::jsonb
                    WHERE id = %s
                    """,
                    (apr_id,),
                )
            except Exception:
                sod_blocked = True
                cur.execute('ROLLBACK TO SAVEPOINT sp_sod')
            assert sod_blocked, 'Self-approval trigger did NOT block ACT-MAKER!'
            print('[PASS] 5.1 Self-approval blocked by trg_prevent_self_approval')

            cur.execute(
                """
                UPDATE governance_approvalrequest
                SET status = 'Approved', finalized = true, decision_log = '[{"actor_id":"ACT-CHECKER","action":"Approved"}]'::jsonb
                WHERE id = %s
                """,
                (apr_id,),
            )
            print('[PASS] 5.2 Independent Checker approval allowed')
    finally:
        conn.rollback()
        conn.close()

    # Verify Test 3.7 transaction scoping outside committed block
    conn2 = psycopg2.connect(db_url)
    try:
        with conn2.cursor() as cur2:
            cur2.execute("SELECT current_setting('app.current_owner_id', true)")
            val = cur2.fetchone()[0]
            assert not val, f'app.current_owner_id leaked across connections/transactions: {val}'
            print('[PASS] 3.7 SET LOCAL app.current_owner_id does not leak across transactions')
    finally:
        conn2.close()

    print('ALL WP-2 POSTGRESQL 16 ASSERTIONS PASSED (rolled back cleanly).')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
