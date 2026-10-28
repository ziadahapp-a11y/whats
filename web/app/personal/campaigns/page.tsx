import { Campaigns } from "./Campaigns";

export const dynamic = "force-dynamic";
export const metadata = { title: "الحملات التسويقية", robots: { index: false } };

export default function Page() {
  return <Campaigns />;
}
