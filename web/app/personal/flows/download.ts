/** Saves `data` as a .json file through the browser's download. */
export function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A plain ASCII file name with the date: browsers drop or mangle Arabic download names (they became "download"). */
export const fileSafe = (s: string, now = new Date()) => `${s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "flow"}-${now.toISOString().slice(0, 10)}`;
