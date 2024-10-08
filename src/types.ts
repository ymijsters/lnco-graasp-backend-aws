export type IdParam = {
  id: string;
};

export type IdsParams = {
  id: string[];
};

export type NonEmptyArray<T> = [T, ...T[]];
export function isNonEmptyArray<T>(arr: T[]): arr is NonEmptyArray<T> {
  return arr.length > 0;
}
