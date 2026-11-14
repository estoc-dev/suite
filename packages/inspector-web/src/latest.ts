/**
 * A function that takes tasks, and gives `show` what the one taken last comes to.
 *
 * What an earlier task comes to is dropped, in whatever order the tasks end, so that a file that
 * is slow to read does not take the place of one chosen after it.
 */
export function latestOnly<T>(show: (value: T) => void): (task: Promise<T>) => Promise<void> {
  let latest: Promise<T> | undefined;
  return async (task) => {
    latest = task;
    const value = await task;
    if (latest === task) show(value);
  };
}
