import { ResetPasswordForm } from "@/components/ResetPasswordForm";

/**
 * Deliberately outside the (app) route group: someone finishing a password
 * reset should not be looking at the team navigation, and the page has to be
 * able to render its own "this link expired" state rather than being bounced
 * to /login by the middleware.
 */
export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
