export default function Archive() {
  return (
    <section className="flex h-full w-full flex-col rounded-lg bg-background-canvas px-5 py-6">
      <h1 className="text-xl font-semibold">휴지통</h1>
      <p className="mt-6 text-xs text-foreground-assistive">삭제한 항목은 30일 동안 보관돼요</p>
      <div className="grid flex-1 place-items-center">
        <p className="text-sm text-foreground-support">휴지통이 비어 있어요.</p>
      </div>
    </section>
  );
}
