import { Suspense } from "react";
import { AuthorizeFlow } from "@/components/oauth/authorize-flow";

/** https://fibuki.com/oauth/authorize: the authorization_endpoint in our OAuth metadata. */
export default function AuthorizePage() {
  return (
    <Suspense fallback={null}>
      <AuthorizeFlow />
    </Suspense>
  );
}
