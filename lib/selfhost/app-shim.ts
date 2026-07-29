/**
 * Self-host client `firebase/app` shim (work item 6, slice D).
 *
 * Drop-in replacement for the tiny subset of `firebase/app` the app uses,
 * swapped at module-resolution time via next.config.ts (env-gated,
 * FIBUKI_BACKEND=selfhost). Zero app-code changes.
 *
 * There is no Firebase project in the self-host build: the firestore / storage
 * / functions / auth shims each talk to fibuki-api directly and ignore the
 * `FirebaseApp` handle entirely (their `getX(app?)` accept and drop it). So
 * `initializeApp`/`getApps`/`getApp` only need to return a stable, truthy
 * singleton so `lib/firebase/config.ts`'s `getApps().length === 0 ? … : …`
 * guard resolves and the app boots.
 */

export interface FirebaseApp {
  readonly name: string;
  readonly options: Record<string, unknown>;
  readonly automaticDataCollectionEnabled: boolean;
  readonly __fibukiApp: true;
}

const _app: FirebaseApp = {
  name: "[DEFAULT]",
  options: {},
  automaticDataCollectionEnabled: false,
  __fibukiApp: true,
};

/** initializeApp(config?, name?) — config/name accepted and ignored. */
export function initializeApp(_options?: unknown, _name?: unknown): FirebaseApp {
  return _app;
}

/** Always non-empty so the singleton guard in config.ts takes the reuse branch. */
export function getApps(): FirebaseApp[] {
  return [_app];
}

export function getApp(_name?: string): FirebaseApp {
  return _app;
}

export function deleteApp(_app?: unknown): Promise<void> {
  return Promise.resolve();
}

export default _app;
