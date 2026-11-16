import { describe, expect, it } from 'vitest';
import { createInitialSeedState } from '../../src/data/seedData';
import { handleFirestoreError, OperationType } from '../../src/lib/firebase';
import { buildWorkspaceSummaryMap } from '../../src/services/firebaseWorkspaceService';

describe('Firebase Workspace & Error Serialization', () => {
  it('builds bounded native-map workspace summary matching firestore.rules blueprint', () => {
    const seed = createInitialSeedState();
    const summary = buildWorkspaceSummaryMap(seed);

    expect(summary.ownersCount).toBe(seed.owners.length);
    expect(summary.propertiesCount).toBe(seed.properties.length);
    expect(summary.unitsCount).toBe(seed.units.length);
    expect(summary.chargesCount).toBe(seed.charges.length);
    expect(summary.receiptsCount).toBe(seed.receipts.length);
    expect(summary.approvalsCount).toBe(seed.approvals.length);
    expect(summary.auditEventsCount).toBe(seed.auditEvents.length);
    expect(summary.latestAuditHash).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    expect(summary.ledgerJournalCount).toBe(seed.ledgerJournals.length);
    expect(summary.trialBalanceTotalCents).toBeGreaterThan(0);
    expect(summary.lastClosedPeriod).toBeTruthy();
    expect(typeof summary.threeWayCheckPassed).toBe('boolean');
  });

  it('serializes Firestore permission errors with structured JSON context', () => {
    expect(() =>
      handleFirestoreError(new Error('Missing or insufficient permissions.'), OperationType.WRITE, 'workspaces/ws-u1')
    ).toThrow(/\"operationType\":\"write\"/);
  });
});
