"use client";

import { ErrorScreen } from "@/components/ErrorScreen";
import "./globals.css";

export default function GlobalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ko">
      <body>
        <ErrorScreen {...props} />
      </body>
    </html>
  );
}
