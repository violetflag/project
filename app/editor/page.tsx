"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { EditorShell } from "@/components/editor/EditorShell";
import { useProject } from "@/lib/store";

function Editor() {
  const id = useSearchParams().get("id");
  const p = useProject(id);
  if (!p) {
    return (
      <div className="grid h-screen place-items-center text-center">
        <div>
          <p className="text-sm text-foreground-support">프로젝트를 찾을 수 없어요. 다른 브라우저에서 만들었다면 여기에는 없어요.</p>
          <Link href="/" className="mt-3 inline-block text-sm text-primary">홈으로 가기</Link>
        </div>
      </div>
    );
  }
  return <EditorShell key={p.id} p={p} />;
}

export default function EditorPage() {
  return <Suspense><Editor /></Suspense>;
}
