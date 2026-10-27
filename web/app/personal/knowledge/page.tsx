import { Knowledge } from "./Knowledge";

export const dynamic = "force-dynamic";
export const metadata = { title: "قاعدة المعرفة", robots: { index: false } };

export default function Page() {
  return <Knowledge />;
}
