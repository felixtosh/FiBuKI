import { AuthProvider } from "@/components/auth";

export default function DeviceAuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthProvider>
      <div className="min-h-screen bg-gradient-to-b from-background to-muted flex items-center justify-center p-4">
        {children}
      </div>
    </AuthProvider>
  );
}
