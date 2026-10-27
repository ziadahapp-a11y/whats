import { RunDetail } from "../../RunDetail";

export const dynamic = "force-dynamic";
export const metadata = { title: "تفاصيل التشغيل", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunDetail id={id} />;
}
