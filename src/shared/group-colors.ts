export const CHROME_GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;

export type ChromeGroupColor = (typeof CHROME_GROUP_COLORS)[number];

export function isChromeGroupColor(value: unknown): value is ChromeGroupColor {
  return typeof value === "string" &&
    (CHROME_GROUP_COLORS as readonly string[]).includes(value);
}
