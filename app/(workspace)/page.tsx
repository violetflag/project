import { brand } from "@/lib/brand";
import { PromptBox } from "@/components/PromptBox";

export default function Home() {
  return (
    <section className="relative flex h-full w-full flex-col items-center overflow-y-auto bg-background-canvas md:rounded-lg">
      {/* Soft violet glow at the bottom of the canvas */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-[radial-gradient(ellipse_at_bottom,rgb(132_93_222/0.10),transparent_70%)]" />
      <div className="relative flex w-full flex-1 flex-col items-center justify-center gap-6 px-4 py-8 md:px-6">
        <h1 className="animate-fade-up text-center text-xl font-medium [word-break:keep-all] md:text-2xl">
          {brand.user}님, 오늘은 어떤 걸 기획해 볼까요?
        </h1>
        <PromptBox />
      </div>
    </section>
  );
}
