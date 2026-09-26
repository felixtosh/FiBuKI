export interface CallbackBox<TArgs extends unknown[], TResult> {
  /** The newest version of the callback, rewritten on every commit. */
  current: ((...args: TArgs) => TResult) | null;
}

export function invokeLatest<TArgs extends unknown[], TResult>(
  box: CallbackBox<TArgs, TResult>,
  args: TArgs,
): TResult | undefined;
