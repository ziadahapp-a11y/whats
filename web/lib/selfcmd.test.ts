import test from "node:test";
import assert from "node:assert/strict";
import { parseBook } from "./flows/selfcmd";
import { localIso } from "./gcal";

const tz = "Asia/Riyadh";
// Wednesday 2026-11-04 13:36 Riyadh
const NOW = Date.parse("2026-11-04T10:36:00Z");
const at = (r: ReturnType<typeof parseBook>) => (r && typeof r === "object" ? localIso(r.start, tz) : r);

test("self command: the real one books today 3pm for Sama Pharma", () => {
  const r = parseBook("احجز اجتماع سما فارما الساعه 3 \n\nbashair@samapharma.com", NOW, { tz });
  assert.ok(r && typeof r === "object");
  assert.equal(localIso(r.start, tz), "2026-11-04T15:00");
  assert.equal(r.email, "bashair@samapharma.com");
  assert.equal(r.name, "سما فارما");
  assert.equal(r.phone, undefined);
});

test("self command: days, minutes, am/pm and phones", () => {
  assert.equal(at(parseBook("احجز اجتماع متجر ورد بكرا الساعة 11 ونص a@b.co", NOW, { tz })), "2026-11-05T11:30");
  assert.equal(at(parseBook("احجز موعد مع ريز الخميس ٤:١٥ a@b.co", NOW, { tz })), "2026-11-05T16:15");
  assert.equal(at(parseBook("احجز اجتماع لمى الاحد 10 صباحا a@b.co", NOW, { tz })), "2026-11-08T10:00");
  assert.equal(at(parseBook("احجز اجتماع لمى 9/11 الساعه 2 م a@b.co", NOW, { tz })), "2026-11-09T14:00");
  const p = parseBook("احجز اجتماع لمى بكرا 3 a@b.co 0551234567", NOW, { tz });
  assert.ok(p && typeof p === "object");
  assert.equal(p.phone, "966551234567");
  assert.equal(localIso(p.start, tz), "2026-11-05T15:00");
});

test("self command: not a command, or missing parts", () => {
  assert.equal(parseBook("؟", NOW, { tz }), null);
  assert.equal(parseBook("تمام احجز لاحقاً", NOW, { tz }), null);
  assert.match(String(parseBook("احجز اجتماع سما الساعه 3", NOW, { tz })), /إيميل/);
  assert.match(String(parseBook("احجز اجتماع سما الساعه 11 a@b.co", NOW, { tz })), /فات/);
});

test("self command: the Fustoqah one, with two days to choose from", () => {
  const r = parseBook("احجز الاجتماع لمتجر فستقة حسب المتاح الساعه 4 اليوم او غدا واعطي اشعار للتاجر بالرقم الموضح بالصوره Info@fustoqah.com", NOW, { tz });
  assert.ok(r && typeof r === "object");
  assert.equal(r.name, "فستقة");
  assert.equal(r.email, "Info@fustoqah.com");
  assert.deepEqual(r.starts.map((t) => localIso(t, tz)), ["2026-11-04T16:00", "2026-11-05T16:00"]);
  const b = parseBook("احجز اجتماع لمى بعد بكرا 3 a@b.co", NOW, { tz });
  assert.ok(b && typeof b === "object");
  assert.deepEqual(b.starts.map((t) => localIso(t, tz)), ["2026-11-06T15:00"]);
});
