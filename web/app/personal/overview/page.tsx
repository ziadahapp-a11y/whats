import { Overview } from "./Overview";

export const dynamic = "force-dynamic";
export const metadata = { title: "نظرة عامة", robots: { index: false } };

export default function Page() {
  return <Overview />;
}
