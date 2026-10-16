import { ConnectorModalProvider } from "@/components/ConnectorModal";
import { Sidebar } from "@/components/Sidebar";
import { FloatingButtons } from "@/components/Floating";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <ConnectorModalProvider>
      <div className="flex h-screen">
        <Sidebar />
        <main className="h-full min-h-0 w-full flex-1 p-2">{children}</main>
      </div>
      <FloatingButtons />
    </ConnectorModalProvider>
  );
}
