"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  onSnapshot,
  type DocumentReference,
  type DocumentSnapshot,
  type FirestoreError,
  type Query,
  type QueryDocumentSnapshot,
} from "firebase/firestore";

export type FirestoreCollectionState<T> = {
  data: T[];
  loading: boolean;
  error: FirestoreError | null;
};

export type FirestoreDocState<T> = {
  data: T | null;
  loading: boolean;
  error: FirestoreError | null;
};

const COLLECTION_LOADING: FirestoreCollectionState<unknown> = Object.freeze({
  data: [],
  loading: true,
  error: null,
});
const COLLECTION_IDLE: FirestoreCollectionState<unknown> = Object.freeze({
  data: [],
  loading: false,
  error: null,
});
const DOC_LOADING: FirestoreDocState<unknown> = Object.freeze({
  data: null,
  loading: true,
  error: null,
});
const DOC_IDLE: FirestoreDocState<unknown> = Object.freeze({
  data: null,
  loading: false,
  error: null,
});

/**
 * Subscribes to a Firestore query via useSyncExternalStore so that subscription
 * setup, snapshot delivery, and listener teardown live outside React's render
 * cycle — no setState-in-effect violations, no tearing under concurrent rendering.
 *
 * Pass `null` for `q` to skip subscribing (use for unauthenticated state).
 * The query and mapper must be referentially stable across renders (memoize at
 * the caller, or build them inside `useMemo` on stable inputs).
 */
export function useFirestoreCollection<T>(
  q: Query | null,
  mapper: (snap: QueryDocumentSnapshot) => T,
  onError?: (err: FirestoreError) => void,
): FirestoreCollectionState<T> {
  const stateRef = useRef<FirestoreCollectionState<T>>(
    (q ? COLLECTION_LOADING : COLLECTION_IDLE) as FirestoreCollectionState<T>,
  );

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!q) {
        if (stateRef.current.data.length || stateRef.current.loading) {
          stateRef.current = COLLECTION_IDLE as FirestoreCollectionState<T>;
          onStoreChange();
        }
        return () => {};
      }

      if (!stateRef.current.loading) {
        stateRef.current = { ...stateRef.current, loading: true };
        onStoreChange();
      }

      return onSnapshot(
        q,
        (snap) => {
          stateRef.current = {
            data: snap.docs.map(mapper),
            loading: false,
            error: null,
          };
          onStoreChange();
        },
        (err) => {
          stateRef.current = {
            ...stateRef.current,
            loading: false,
            error: err,
          };
          onStoreChange();
          onError?.(err);
        },
      );
    },
    [q, mapper, onError],
  );

  return useSyncExternalStore(
    subscribe,
    () => stateRef.current,
    () =>
      (q ? COLLECTION_LOADING : COLLECTION_IDLE) as FirestoreCollectionState<T>,
  );
}

/**
 * Single-document variant of useFirestoreCollection.
 */
export function useFirestoreDoc<T>(
  ref: DocumentReference | null,
  mapper: (snap: DocumentSnapshot) => T | null,
  onError?: (err: FirestoreError) => void,
): FirestoreDocState<T> {
  const stateRef = useRef<FirestoreDocState<T>>(
    (ref ? DOC_LOADING : DOC_IDLE) as FirestoreDocState<T>,
  );

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!ref) {
        if (stateRef.current.data !== null || stateRef.current.loading) {
          stateRef.current = DOC_IDLE as FirestoreDocState<T>;
          onStoreChange();
        }
        return () => {};
      }

      if (!stateRef.current.loading) {
        stateRef.current = { ...stateRef.current, loading: true };
        onStoreChange();
      }

      return onSnapshot(
        ref,
        (snap) => {
          stateRef.current = {
            data: mapper(snap),
            loading: false,
            error: null,
          };
          onStoreChange();
        },
        (err) => {
          stateRef.current = {
            data: null,
            loading: false,
            error: err,
          };
          onStoreChange();
          onError?.(err);
        },
      );
    },
    [ref, mapper, onError],
  );

  return useSyncExternalStore(
    subscribe,
    () => stateRef.current,
    () => (ref ? DOC_LOADING : DOC_IDLE) as FirestoreDocState<T>,
  );
}
