"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SettingsIndexRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/settings/sign-in-security");
  }, [router]);

  return null;
}
