import { Inbox } from "./Inbox";

export const dynamic = "force-dynamic";
export const metadata = { title: "صندوق الوارد", robots: { index: false } };

export default function Page() {
  return <Inbox />;
}
