import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  auth,
  db,
  googleAuthProvider,
  handleFirestoreError,
  OperationType,
} from '../lib/firebase';
import { OwnerId } from '../types/prms';
import { SeedState } from '../data/seedData';

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function sanitizeId(raw: string, fallbackPrefix = 'id'): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return SAFE_ID_PATTERN.test(cleaned) ? cleaned : `${fallbackPrefix}_${Date.now()}`;
}

export interface FirebaseAuthenticatedOperator {
  uid: string;
  email: string;
  displayName: string;
  idToken: string;
}

export async function syncFirebaseUserProfile(user: User): Promise<void> {
  const uid = sanitizeId(user.uid, 'uid');
  const displayName = (user.displayName || user.email || 'Operator').trim().slice(0, 120) || 'Operator';
  const email = (user.email || '').trim().slice(0, 254);

  const userPath = `users/${uid}`;
  const userRef = doc(db, 'users', uid);

  try {
    const existing = await getDoc(userRef);
    if (!existing.exists()) {
      await setDoc(userRef, {
        uid,
        displayName,
        role: 'User',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(userRef, {
        displayName,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, userPath);
  }

  if (email.length >= 3) {
    const privatePath = `users/${uid}/private/info`;
    const privateRef = doc(db, 'users', uid, 'private', 'info');
    try {
      const existingPriv = await getDoc(privateRef);
      if (!existingPriv.exists()) {
        await setDoc(privateRef, {
          uid,
          email,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(privateRef, {
          email,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, privatePath);
    }
  }
}

export async function signInWithGoogleFirebase(): Promise<FirebaseAuthenticatedOperator> {
  const credential = await signInWithPopup(auth, googleAuthProvider);
  const user = credential.user;
  if (!user.emailVerified) {
    throw new Error('Verified Google email is required to access Firestore workspace.');
  }
  const idToken = await user.getIdToken();
  await syncFirebaseUserProfile(user);
  return {
    uid: sanitizeId(user.uid, 'uid'),
    email: user.email || '',
    displayName: (user.displayName || user.email || 'AD-PRMS Operator').trim().slice(0, 120),
    idToken,
  };
}

export async function signOutFirebase(): Promise<void> {
  if (auth.currentUser) {
    await signOut(auth);
  }
}

export function buildWorkspaceSummaryMap(seed: SeedState) {
  const latestHash = (seed.auditEvents[0]?.id || 'GENESIS').slice(0, 128);
  const ledgerJournals = seed.ledgerJournals || [];
  const totalDebitCents = ledgerJournals.reduce(
    (sum, j) => sum + j.lines.reduce((ls, l) => ls + Math.round(l.debitCents || 0), 0),
    0
  );
  const closedPeriod = [...(seed.accountingPeriods || [])]
    .reverse()
    .find((p) => p.status === 'Closed');
  const depositSum = (seed.depositCustodies || [])
    .filter((d) => d.status === 'Held' || d.status === 'Refund Pending')
    .reduce((s, d) => s + (d.heldCents || 0), 0);

  return {
    ownersCount: Math.max(0, seed.owners.length),
    propertiesCount: Math.max(0, seed.properties.length),
    unitsCount: Math.max(0, seed.units.length),
    chargesCount: Math.max(0, seed.charges.length),
    receiptsCount: Math.max(0, seed.receipts.length),
    approvalsCount: Math.max(0, seed.approvals.length),
    auditEventsCount: Math.max(0, seed.auditEvents.length),
    latestAuditHash: sanitizeId(latestHash, 'GENESIS'),
    ledgerJournalCount: Math.max(0, ledgerJournals.length),
    trialBalanceTotalCents: Math.max(0, totalDebitCents),
    lastClosedPeriod: (closedPeriod?.periodCode || 'None').slice(0, 32),
    threeWayCheckPassed: depositSum >= 0,
  };
}

export async function syncWorkspaceSnapshotToFirestore(input: {
  uid: string;
  activeOwnerId: OwnerId;
  revision: number;
  seed: SeedState;
}): Promise<void> {
  const safeUid = sanitizeId(input.uid, 'uid');
  const workspaceId = sanitizeId(`ws-${safeUid}`, 'ws');
  const workspacePath = `workspaces/${workspaceId}`;
  const workspaceRef = doc(db, 'workspaces', workspaceId);
  const summary = buildWorkspaceSummaryMap(input.seed);
  const revision = Math.max(0, Math.min(1000000000, Math.floor(input.revision)));

  try {
    const snap = await getDoc(workspaceRef);
    if (!snap.exists()) {
      await setDoc(workspaceRef, {
        ownerUid: safeUid,
        activeOwnerId: input.activeOwnerId,
        updatedByUid: safeUid,
        revision,
        summary,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(workspaceRef, {
        activeOwnerId: input.activeOwnerId,
        updatedByUid: safeUid,
        revision,
        summary,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, workspacePath);
  }
}

export async function appendAuditEventToFirestore(input: {
  uid: string;
  ownerEntityId: OwnerId;
  eventId: string;
  actor: string;
  action: string;
  sha256Hash: string;
}): Promise<void> {
  const safeUid = sanitizeId(input.uid, 'uid');
  const workspaceId = sanitizeId(`ws-${safeUid}`, 'ws');
  const safeEventId = sanitizeId(input.eventId, 'AUD');
  const eventPath = `workspaces/${workspaceId}/auditEvents/${safeEventId}`;
  const eventRef = doc(db, 'workspaces', workspaceId, 'auditEvents', safeEventId);

  try {
    await setDoc(eventRef, {
      ownerUid: safeUid,
      ownerEntityId: input.ownerEntityId,
      actor: input.actor.trim().slice(0, 120) || 'Operator',
      action: input.action.trim().slice(0, 160) || 'Event',
      sha256Hash: sanitizeId(input.sha256Hash || safeEventId, 'HASH'),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, eventPath);
  }
}

export async function recordPeriodClosureToFirestore(input: {
  uid: string;
  ownerEntityId: OwnerId;
  periodCode: string;
  trialBalanceDebitCents: number;
  trialBalanceCreditCents: number;
  journalCount: number;
  closedByActor: string;
}): Promise<void> {
  const safeUid = sanitizeId(input.uid, 'uid');
  const workspaceId = sanitizeId(`ws-${safeUid}`, 'ws');
  const safeClosureId = sanitizeId(`CLS-${input.ownerEntityId}-${input.periodCode}-${Date.now()}`, 'CLS');
  const closurePath = `workspaces/${workspaceId}/periodClosures/${safeClosureId}`;
  const closureRef = doc(db, 'workspaces', workspaceId, 'periodClosures', safeClosureId);

  try {
    await setDoc(closureRef, {
      ownerUid: safeUid,
      ownerEntityId: input.ownerEntityId,
      periodCode: input.periodCode.slice(0, 16),
      trialBalanceDebitCents: Math.max(0, Math.round(input.trialBalanceDebitCents)),
      trialBalanceCreditCents: Math.max(0, Math.round(input.trialBalanceCreditCents)),
      journalCount: Math.max(0, Math.round(input.journalCount)),
      closedByActor: input.closedByActor.trim().slice(0, 120) || 'Operator',
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, closurePath);
  }
}

export function observeFirebaseAuthReadiness(onState: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, (user) => {
    onState(user);
  });
}

export function subscribeToWorkspaceSnapshot(
  uid: string,
  onUpdate: (data: { revision?: number; activeOwnerId?: OwnerId } | null) => void
): () => void {
  const safeUid = sanitizeId(uid, 'uid');
  const workspaceId = sanitizeId(`ws-${safeUid}`, 'ws');
  const workspacePath = `workspaces/${workspaceId}`;
  const workspaceRef = doc(db, 'workspaces', workspaceId);

  return onSnapshot(
    workspaceRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        onUpdate(null);
        return;
      }
      const data = snapshot.data() as { revision?: number; activeOwnerId?: OwnerId };
      onUpdate(data);
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, workspacePath);
    }
  );
}
