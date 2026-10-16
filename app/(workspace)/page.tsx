import { brand } from "@/lib/brand";
import { ConnectPill } from "@/components/ConnectPill";
import { PromptBox } from "@/components/PromptBox";

export default function Home() {
  return (
    <section className="relative flex h-full w-full flex-col items-center overflow-hidden rounded-lg bg-background-canvas">
      {/* Soft violet glow at the bottom of the canvas */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-[radial-gradient(ellipse_at_bottom,rgb(132_93_222/0.10),transparent_70%)]" />
      <div className="relative flex w-full flex-1 flex-col items-center justify-center gap-6 px-6">
        <header className="animate-fade-up flex w-full flex-col items-center gap-4 text-center">
          <ConnectPill />
          <h1 className="text-2xl font-medium [word-break:keep-all]">
            {brand.user}님, 오늘은 어떤 걸 만들어 볼까요?
          </h1>
        </header>
        <PromptBox />
      </div>
      <p className="relative pb-5 text-[11px] text-foreground-assistive">
        {brand.name} {brand.version}
      </p>
    </section>
  );
}
