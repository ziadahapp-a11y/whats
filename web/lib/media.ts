// What the inbox may attach on the official number, by Meta's own limits for Cloud API media.

export type MediaKind = "image" | "document";

const MB = 1024 * 1024;

export const MEDIA_RULES: Record<MediaKind, { types: string[]; maxBytes: number }> = {
  image: { types: ["image/jpeg", "image/png"], maxBytes: 5 * MB },
  document: {
    types: [
      "application/pdf",
      "text/plain",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    maxBytes: 100 * MB,
  },
};

/** The kind a file is sent as, or null when WhatsApp does not accept it. */
export function mediaKind(mime: string): MediaKind | null {
  for (const kind of Object.keys(MEDIA_RULES) as MediaKind[]) if (MEDIA_RULES[kind].types.includes(mime)) return kind;
  return null;
}

/** A plain-language reason a file cannot be attached, or null when it can. */
export function mediaProblem(mime: string, size: number): string | null {
  const kind = mediaKind(mime);
  if (!kind) return "نوع الملف غير مدعوم. المسموح: صور JPG و PNG، وملفات PDF و Word و Excel و PowerPoint والنص.";
  const max = MEDIA_RULES[kind].maxBytes;
  if (size > max) return `${kind === "image" ? "الصورة" : "الملف"} أكبر من ${max / MB} ميقا.`;
  return null;
}
